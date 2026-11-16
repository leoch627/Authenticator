import { getCredentials } from "./models/credentials";
import { Encryption } from "./models/encryption";
import { EntryStorage, ManagedStorage } from "./models/storage";
import {
  Dropbox,
  Drive,
  OneDrive,
  DRIVE_SCOPE,
  DRIVE_TOKEN_URL,
  DROPBOX_TOKEN_URL,
  ONEDRIVE_TOKEN_URL,
  getOneDriveScope,
  requestOAuthToken,
} from "./models/backup";
import {
  getSiteName,
  getMatchedEntries,
  getCurrentTab,
  okToInjectContentScript,
} from "./utils";
import { CodeState } from "./models/otp";

import { getOTPAuthPerLineFromOPTAuthMigration } from "./models/migration";
import { hasChromeIdentity, isChrome, isEdge, isFirefox } from "./browser";
import { UserSettings } from "./models/settings";

let contentTab: chrome.tabs.Tab | undefined;

chrome.runtime.onMessage.addListener(async (message, sender) => {
  await UserSettings.updateItems();

  if (message.action === "getCapture") {
    if (!sender.tab) {
      return;
    }
    const url = await getCapture(sender.tab);
    if (contentTab && contentTab.id) {
      message.info.url = url;
      chrome.tabs.sendMessage(contentTab.id, {
        action: "sendCaptureUrl",
        info: message.info,
      });
    }
  } else if (message.action === "getTotp") {
    getTotp(message.info);
  } else if (message.action === "cachePassphrase") {
    chrome.storage.session.set({
      cachedPassphrase: message.value,
      cachedKeyId: message.keyId,
    });
    chrome.alarms.clear("autolock");
    setAutolock();
  } else if (["dropbox", "drive", "onedrive"].indexOf(message.action) > -1) {
    getBackupToken(message.action);
  } else if (message.action === "lock") {
    chrome.storage.session.set({ cachedPassphrase: null, cachedKeyId: null });
  } else if (message.action === "resetAutolock") {
    chrome.alarms.clear("autolock");
    setAutolock();
  } else if (message.action === "updateContentTab") {
    contentTab = message.data;
  } else if (message.action === "updateContextMenu") {
    updateContextMenu();
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

chrome.alarms.onAlarm.addListener(() => {
  chrome.storage.session.set({ cachedPassphrase: null, cachedKeyId: null });
  if (contentTab && contentTab.id) {
    chrome.tabs.sendMessage(contentTab.id, { action: "stopCapture" });
  }
  chrome.runtime.sendMessage({ action: "stopImport" });

  // https://stackoverflow.com/a/56483156
  return true;
});

async function getCapture(tab: chrome.tabs.Tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  return dataUrl;
}

async function getTotp(text: string, silent = false) {
  if (!contentTab || !contentTab.id || !text) {
    return false;
  }
  const id = contentTab.id;

  if (text.indexOf("otpauth://") !== 0) {
    if (text.indexOf("otpauth-migration://") === 0) {
      const otpUrls = getOTPAuthPerLineFromOPTAuthMigration(text);
      if (otpUrls.length === 0) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
        return false;
      }

      const getTotpPromises: Array<Promise<boolean>> = [];
      for (const otpUrl of otpUrls) {
        getTotpPromises.push(getTotp(otpUrl, true));
      }

      const getTotpResults = await Promise.allSettled(getTotpPromises);
      const failedCount = getTotpResults.filter((res) => !res).length;
      if (failedCount === otpUrls.length) {
        !silent && chrome.tabs.sendMessage(id, { action: "migrationfail" });
        return false;
      }

      if (failedCount > 0) {
        !silent &&
          chrome.tabs.sendMessage(id, { action: "migrationpartlyfail" });
        return true;
      }

      !silent && chrome.tabs.sendMessage(id, { action: "migrationsuccess" });
      return true;
    } else if (text === "error decoding QR Code") {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      !silent && chrome.tabs.sendMessage(id, { action: "text", text });
      return true;
    }
  } else {
    let uri = text.split("otpauth://")[1];
    let type = uri.substr(0, 4).toLowerCase();
    uri = uri.substr(5);
    let label = uri.split("?")[0];
    const parameterPart = uri.split("?")[1];
    if (!label || !parameterPart) {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      let secret = "";
      let account: string | undefined;
      let issuer: string | undefined;
      let algorithm: string | undefined;
      let period: number | undefined;
      let digits: number | undefined;

      try {
        label = decodeURIComponent(label);
      } catch (error) {
        console.error(error);
      }
      if (label.indexOf(":") !== -1) {
        issuer = label.split(":")[0];
        account = label.split(":")[1];
      } else {
        account = label;
      }
      const parameters = parameterPart.split("&");
      const {
        cachedPassphrase,
        cachedKeyId,
      } = await chrome.storage.session.get();
      parameters.forEach((item) => {
        const parameter = item.split("=");
        if (parameter[0].toLowerCase() === "secret") {
          secret = parameter[1];
        } else if (parameter[0].toLowerCase() === "issuer") {
          try {
            issuer = decodeURIComponent(parameter[1]);
          } catch {
            issuer = parameter[1];
          }
          issuer = issuer.replace(/\+/g, " ");
        } else if (parameter[0].toLowerCase() === "counter") {
          // let counter = Number(parameter[1]);
          // counter = isNaN(counter) || counter < 0 ? 0 : counter;
        } else if (parameter[0].toLowerCase() === "period") {
          period = Number(parameter[1]);
          period =
            isNaN(period) || period < 0 || period > 60 || 60 % period !== 0
              ? undefined
              : period;
        } else if (parameter[0].toLowerCase() === "digits") {
          digits = Number(parameter[1]);
          digits = isNaN(digits) || digits === 0 ? 6 : digits;
        } else if (parameter[0].toLowerCase() === "algorithm") {
          algorithm = parameter[1];
        }
      });

      if (!secret) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
        return false;
      } else if (
        !/^[0-9a-f]+$/i.test(secret) &&
        !/^[2-7a-z]+=*$/i.test(secret)
      ) {
        !silent && chrome.tabs.sendMessage(id, { action: "secretqr", secret });
        return false;
      } else {
        const encryption = new Encryption(cachedPassphrase, cachedKeyId);
        const hash = crypto.randomUUID();
        if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "totp"
        ) {
          type = "hex";
        } else if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "hotp"
        ) {
          type = "hhex";
        }
        const entryData: { [hash: string]: RawOTPStorage } = {};
        entryData[hash] = {
          account,
          hash,
          issuer,
          secret,
          type,
          encrypted: false,
          index: 0,
          counter: 0,
          pinned: false,
        };
        if (period) {
          entryData[hash].period = period;
        }
        if (digits) {
          entryData[hash].digits = digits;
        }
        if (algorithm) {
          entryData[hash].algorithm = algorithm;
        }
        if (
          // If the entries are encrypted and we aren't unlocked, error.
          (await EntryStorage.hasEncryptionKey()) !==
          encryption.getEncryptionStatus()
        ) {
          !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
          return false;
        }
        await EntryStorage.import(encryption, entryData);
        !silent && chrome.tabs.sendMessage(id, { action: "added", account });
        return true;
      }
    }
  }
}

async function getBackupToken(service: string) {
  let signedIn = false;
  try {
    if (service === "dropbox") {
      signedIn = await signInToDropbox();
    } else if (service === "drive") {
      signedIn = await signInToDrive();
    } else if (service === "onedrive") {
      signedIn = await signInToOneDrive();
    }
  } catch (error) {
    console.error(error);
  }
  if (!signedIn) {
    return;
  }

  // The popup may still be open, let it show the signed in state
  chrome.runtime
    .sendMessage({ action: "backupToken", service })
    .catch(() => undefined);
  await uploadBackup(service);
}

// Resolves to the parameters the provider put on the redirect URL
function launchWebAuthFlow(url: string) {
  return new Promise(
    (resolve: (value: URLSearchParams | undefined) => void) => {
      chrome.identity.launchWebAuthFlow(
        { url, interactive: true },
        (responseUrl) => {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message);
          }
          if (!responseUrl) {
            return resolve(undefined);
          }
          const { search, hash } = new URL(responseUrl);
          resolve(
            new URLSearchParams(
              [search.slice(1), hash.slice(1)].filter(Boolean).join("&")
            )
          );
        }
      );
    }
  );
}

function base64Url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signInToDropbox() {
  // Authorization code flow with PKCE. Unlike the implicit grant it gives us
  // a refresh token, which is needed as Dropbox access tokens are short-lived.
  const clientId = getCredentials().dropbox.client_id;
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

  const params = await launchWebAuthFlow(
    "https://www.dropbox.com/oauth2/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        token_access_type: "offline",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })
  );
  const code = params?.get("code");
  if (!code) {
    return false;
  }

  const { body } = await requestOAuthToken(DROPBOX_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (body.error || !body.access_token) {
    return false;
  }

  await UserSettings.updateItems();
  UserSettings.items.dropboxToken = body.access_token;
  UserSettings.items.dropboxRefreshToken = body.refresh_token;
  UserSettings.items.dropboxRevoked = undefined;
  await UserSettings.commitItems();
  return true;
}

async function signInToDrive() {
  if (hasChromeIdentity) {
    const token = await new Promise(
      (resolve: (value: string | undefined) => void) => {
        chrome.identity.getAuthToken(
          { interactive: true, scopes: [DRIVE_SCOPE] },
          (token) => {
            if (chrome.runtime.lastError) {
              console.error(chrome.runtime.lastError.message);
            }
            resolve(token || undefined);
          }
        );
      }
    );
    if (!token) {
      return false;
    }

    await UserSettings.updateItems();
    UserSettings.items.driveToken = token;
    UserSettings.items.driveRevoked = undefined;
    await UserSettings.commitItems();
    return true;
  }

  let redirectUri = "https://authenticator.cc/oauth";
  if (isEdge) {
    redirectUri = "https://authenticator.cc/oauth-edge";
  } else if (isFirefox) {
    redirectUri = chrome.identity.getRedirectURL();
  }

  const params = await launchWebAuthFlow(
    "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        response_type: "code",
        access_type: "offline",
        client_id: getCredentials().drive.client_id,
        scope: DRIVE_SCOPE,
        prompt: "consent",
        redirect_uri: redirectUri,
      })
  );
  const code = params?.get("code");
  if (!code) {
    return false;
  }

  const { body } = await requestOAuthToken(DRIVE_TOKEN_URL, {
    client_id: getCredentials().drive.client_id,
    client_secret: getCredentials().drive.client_secret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (body.error || !body.access_token) {
    return false;
  }

  await UserSettings.updateItems();
  UserSettings.items.driveToken = body.access_token;
  UserSettings.items.driveRefreshToken = body.refresh_token;
  UserSettings.items.driveRevoked = undefined;
  await UserSettings.commitItems();
  return true;
}

async function signInToOneDrive() {
  await UserSettings.updateItems();
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = getOneDriveScope();

  const params = await launchWebAuthFlow(
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" +
      new URLSearchParams({
        client_id: getCredentials().onedrive.client_id,
        response_type: "code",
        redirect_uri: redirectUri,
        scope,
        response_mode: "query",
        prompt: "consent",
      })
  );
  const code = params?.get("code");
  if (!code) {
    return false;
  }

  // Need to trade code we got from launchWebAuthFlow for a
  // token & refresh token
  const { body } = await requestOAuthToken(ONEDRIVE_TOKEN_URL, {
    client_id: getCredentials().onedrive.client_id,
    client_secret: getCredentials().onedrive.client_secret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    scope,
  });
  if (body.error || !body.access_token) {
    return false;
  }

  await UserSettings.updateItems();
  UserSettings.items.oneDriveToken = body.access_token;
  UserSettings.items.oneDriveRefreshToken = body.refresh_token;
  UserSettings.items.oneDriveRevoked = undefined;
  await UserSettings.commitItems();
  return true;
}

async function uploadBackup(service: string) {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  const encryption = new Encryption(cachedPassphrase, cachedKeyId);

  switch (service) {
    case "dropbox":
      await new Dropbox().upload(encryption);
      break;

    case "drive":
      await new Drive().upload(encryption);
      break;

    case "onedrive":
      await new OneDrive().upload(encryption);
      break;

    default:
      break;
  }
}

// Show issue page after first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") {
    return;
  } else if (await ManagedStorage.get("disableInstallHelp", false)) {
    return;
  }

  let url: string | null = null;

  if (isChrome) {
    url = "https://otp.ee/chromeissues";
  }

  if (url) {
    chrome.tabs.create({ url, active: true });
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

chrome.commands.onCommand.addListener(async (command: string) => {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();

  let tab: chrome.tabs.Tab | undefined;

  switch (command) {
    case "scan-qr":
      if (cachedPassphrase === null || cachedPassphrase === undefined) {
        return;
      }

      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;
        chrome.tabs.sendMessage(tab.id, { action: "capture" });
      }
      break;

    case "autofill":
      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;

        const siteName = await getSiteName();
        const entries = await EntryStorage.get();
        const matchedEntries = getMatchedEntries(siteName, entries);

        if (matchedEntries && matchedEntries.length === 1) {
          const entry = matchedEntries[0];
          const encryption = new Encryption(cachedPassphrase, cachedKeyId);
          entry.applyEncryption(encryption);

          if (
            entry.code !== CodeState.Encrypted &&
            entry.code !== CodeState.Invalid
          ) {
            chrome.tabs.sendMessage(tab.id, {
              action: "pastecode",
              code: matchedEntries[0].code,
            });
          }
        }
      }
      break;

    default:
      break;
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

async function setAutolock() {
  const enforcedAutolock = Number(
    await ManagedStorage.get("enforceAutolock", false)
  );

  if (enforcedAutolock && enforcedAutolock > 0) {
    chrome.alarms.create("autolock", { delayInMinutes: enforcedAutolock });
    return;
  }

  // Set default autolock value
  if (UserSettings.items.autolock === undefined) {
    UserSettings.items.autolock = 30;
  }

  if (Number(UserSettings.items.autolock) > 0) {
    chrome.alarms.create("autolock", {
      delayInMinutes: Number(UserSettings.items.autolock),
    });
  }
}

async function updateContextMenu() {
  chrome.permissions.contains(
    {
      permissions: ["contextMenus"],
    },
    (result) => {
      if (result) {
        if (UserSettings.items.enableContextMenu === true) {
          chrome.contextMenus.removeAll();
          chrome.contextMenus.create({
            id: "otpContextMenu",
            title: chrome.i18n.getMessage("extName"),
            contexts: ["all"],
          });
          chrome.contextMenus.onClicked.addListener((info, tab) => {
            let popupUrl = "view/popup.html?popup=true";
            if (tab && tab.url && tab.title) {
              popupUrl +=
                "&url=" +
                encodeURIComponent(tab.url) +
                "&title=" +
                encodeURIComponent(tab.title);
            }
            let windowType;
            if (isFirefox) {
              windowType = "detached_panel";
            } else {
              windowType = "panel";
            }
            chrome.windows.create({
              url: chrome.runtime.getURL(popupUrl),
              type: windowType as chrome.windows.createTypeEnum,
              height: 400,
              width: 320,
            });

            // https://stackoverflow.com/a/56483156
            return true;
          });
        } else {
          chrome.contextMenus.removeAll();
        }
      }
    }
  );
}

updateContextMenu();
