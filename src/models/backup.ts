import { hasChromeIdentity } from "../browser";
import { getCredentials } from "./credentials";
import { Encryption } from "./encryption";
import { UserSettings } from "./settings";
import { EntryStorage } from "./storage";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
export const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
export const ONEDRIVE_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_FOLDER_NAME = "Authenticator Backups";
const GRAPH_API = "https://graph.microsoft.com/v1.0";

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface ApiError {
  error?: { message?: string } | string;
}

export function getOneDriveScope() {
  return [
    "https://graph.microsoft.com/Files.ReadWrite" +
      (UserSettings.items.oneDriveBusiness !== true ? ".AppFolder" : ""),
    "https://graph.microsoft.com/User.Read",
    "offline_access",
  ].join(" ");
}

// Entries are only encrypted once a password has been set, so there may be no
// default encryption to hand to a backup provider.
export function getBackupEncryption(accounts: {
  encryption: Map<string, EncryptionInterface>;
  defaultEncryption?: string;
}): EncryptionInterface {
  return (
    accounts.encryption.get(accounts.defaultEncryption || "") ||
    new Encryption("", "")
  );
}

export async function requestOAuthToken(
  url: string,
  params: { [key: string]: string }
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const body: OAuthTokenResponse = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    console.error(body.error_description || body.error || response.status);
  }
  return { status: response.status, body };
}

function backupFileName() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".json";
}

function logApiError(response: Response, body: ApiError) {
  const message =
    typeof body.error === "object" ? body.error.message : body.error;
  console.error(message || `Request failed with status ${response.status}`);
}

// Providers use fetch rather than XMLHttpRequest because uploads can be
// started from the background service worker, where XMLHttpRequest doesn't
// exist.
abstract class OAuthBackupProvider {
  protected abstract getStoredToken(): string | undefined;

  // Returns a fresh access token. When the provider says access is gone for
  // good, implementations clear what they stored and set the revoked flag.
  protected abstract refreshToken(
    rejectedToken?: string
  ): Promise<string | undefined>;

  // Sends an authorized request, refreshing the access token once if it is
  // rejected. Resolves to undefined when there is no usable token.
  protected async authorizedFetch(
    url: string,
    init: RequestInit & { headers?: { [name: string]: string } } = {}
  ) {
    const send = (token: string) =>
      fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: "Bearer " + token },
      });

    await UserSettings.updateItems();
    let token = this.getStoredToken() || (await this.refreshToken());
    if (!token) {
      return undefined;
    }
    let response = await send(token);
    if (response.status === 401) {
      token = await this.refreshToken(token);
      if (!token) {
        return undefined;
      }
      response = await send(token);
    }
    return response.status === 401 ? undefined : response;
  }
}

export class Dropbox extends OAuthBackupProvider implements BackupProvider {
  protected getStoredToken() {
    return UserSettings.items.dropboxToken;
  }

  // Tokens from the old implicit grant have no refresh token and can't be
  // renewed, so the user has to sign in again once Dropbox rejects them.
  protected async refreshToken() {
    await UserSettings.updateItems();
    const refreshToken = UserSettings.items.dropboxRefreshToken;
    if (!refreshToken) {
      await this.revoke();
      return undefined;
    }

    const { body } = await requestOAuthToken(DROPBOX_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getCredentials().dropbox.client_id,
    });
    if (body.error === "invalid_grant") {
      await this.revoke();
      return undefined;
    }
    if (body.error || !body.access_token) {
      return undefined;
    }

    await UserSettings.updateItems();
    UserSettings.items.dropboxToken = body.access_token;
    await UserSettings.commitItems();
    return body.access_token;
  }

  private async revoke() {
    await UserSettings.updateItems();
    UserSettings.items.dropboxToken = undefined;
    UserSettings.items.dropboxRefreshToken = undefined;
    UserSettings.items.dropboxRevoked = true;
    await UserSettings.commitItems();
  }

  async upload(encryption: EncryptionInterface) {
    await UserSettings.updateItems();

    if (UserSettings.items.dropboxEncrypted === undefined) {
      // Encrypt by default if user hasn't set yet
      UserSettings.items.dropboxEncrypted = true;
      await UserSettings.commitItems();
    }
    const exportData = await EntryStorage.backupGetExport(
      encryption,
      UserSettings.items.dropboxEncrypted === true
    );
    const backup = JSON.stringify(exportData, null, 2);

    const response = await this.authorizedFetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: "/" + backupFileName(),
            mode: "add",
            autorename: true,
          }),
        },
        body: backup,
      }
    );
    if (!response) {
      return false;
    }
    const res = await response.json().catch(() => ({}));
    if (!response.ok || !res.name) {
      logApiError(response, { error: res.error_summary });
      return false;
    }
    return true;
  }

  async getUser() {
    try {
      const response = await this.authorizedFetch(
        "https://api.dropboxapi.com/2/users/get_current_account",
        { method: "POST" }
      );
      if (!response) {
        return "Error: Access revoked or expired.";
      }
      const res = await response.json();
      if (!response.ok || !res.email) {
        console.error("Could not find email in response.", res);
        return "Error";
      }
      return res.email as string;
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}

export class Drive extends OAuthBackupProvider implements BackupProvider {
  protected getStoredToken() {
    return UserSettings.items.driveToken;
  }

  protected async refreshToken(rejectedToken?: string) {
    if (hasChromeIdentity) {
      if (rejectedToken) {
        // Clear invalid token from
        // chrome://identity-internals/
        await chrome.identity.removeCachedAuthToken({ token: rejectedToken });
      }
      const token = await new Promise(
        (resolve: (value: string | undefined) => void) => {
          chrome.identity.getAuthToken(
            { interactive: false, scopes: [DRIVE_SCOPE] },
            (token) => {
              if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
              }
              resolve(token || undefined);
            }
          );
        }
      );
      await UserSettings.updateItems();
      UserSettings.items.driveToken = token;
      if (!token) {
        UserSettings.items.driveRevoked = true;
      }
      await UserSettings.commitItems();
      return token;
    }

    await UserSettings.updateItems();
    const refreshToken = UserSettings.items.driveRefreshToken;
    if (!refreshToken) {
      await this.revoke();
      return undefined;
    }

    const { status, body } = await requestOAuthToken(DRIVE_TOKEN_URL, {
      client_id: getCredentials().drive.client_id,
      client_secret: getCredentials().drive.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (status === 401 || body.error === "invalid_grant") {
      await this.revoke();
      return undefined;
    }
    if (body.error || !body.access_token) {
      return undefined;
    }

    await UserSettings.updateItems();
    UserSettings.items.driveToken = body.access_token;
    await UserSettings.commitItems();
    return body.access_token;
  }

  private async revoke() {
    await UserSettings.updateItems();
    UserSettings.items.driveToken = undefined;
    UserSettings.items.driveRefreshToken = undefined;
    UserSettings.items.driveRevoked = true;
    await UserSettings.commitItems();
  }

  private async forgetFolder(folder: string) {
    await UserSettings.updateItems();
    if (UserSettings.items.driveFolder === folder) {
      UserSettings.items.driveFolder = undefined;
      await UserSettings.commitItems();
    }
  }

  private async getFolder() {
    await UserSettings.updateItems();
    const folder = UserSettings.items.driveFolder;
    if (folder) {
      const response = await this.authorizedFetch(
        `${DRIVE_API}/files/${encodeURIComponent(folder)}?fields=trashed`
      );
      if (!response) {
        return undefined;
      }
      const res = await response.json().catch(() => ({}));
      if (response.status === 404 || res.trashed) {
        // The folder was deleted, or this app can no longer see it
        await this.forgetFolder(folder);
      } else if (!response.ok) {
        logApiError(response, res);
        return undefined;
      } else {
        return folder;
      }
    }

    const response = await this.authorizedFetch(`${DRIVE_API}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    if (!response) {
      return undefined;
    }
    const res = await response.json().catch(() => ({}));
    if (!response.ok || !res.id) {
      logApiError(response, res);
      return undefined;
    }
    await UserSettings.updateItems();
    UserSettings.items.driveFolder = res.id;
    await UserSettings.commitItems();
    return res.id as string;
  }

  async upload(encryption: EncryptionInterface) {
    await UserSettings.updateItems();
    if (UserSettings.items.driveEncrypted === undefined) {
      UserSettings.items.driveEncrypted = true;
      await UserSettings.commitItems();
    }
    const exportData = await EntryStorage.backupGetExport(
      encryption,
      UserSettings.items.driveEncrypted === true
    );
    const backup = JSON.stringify(exportData, null, 2);

    const folderId = await this.getFolder();
    if (!folderId) {
      return false;
    }

    const boundary = "segment_marker";
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({ name: backupFileName(), parents: [folderId] }),
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "",
      backup,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await this.authorizedFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    if (!response) {
      return false;
    }
    const res = await response.json().catch(() => ({}));
    if (!response.ok || !res.id) {
      if (response.status === 404) {
        // The folder vanished between the check and the upload; recreate it
        // on the next attempt.
        await this.forgetFolder(folderId);
      }
      logApiError(response, res);
      return false;
    }
    return true;
  }

  async getUser() {
    try {
      const response = await this.authorizedFetch(
        `${DRIVE_API}/about?fields=user`
      );
      if (!response) {
        return "Error: Access revoked or expired.";
      }
      const res = await response.json();
      if (!response.ok || !res.user) {
        logApiError(response, res);
        return "Error";
      }
      return res.user.emailAddress as string;
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}

export class OneDrive extends OAuthBackupProvider implements BackupProvider {
  protected getStoredToken() {
    return UserSettings.items.oneDriveToken;
  }

  protected async refreshToken() {
    await UserSettings.updateItems();
    const refreshToken = UserSettings.items.oneDriveRefreshToken;
    if (!refreshToken) {
      await this.revoke();
      return undefined;
    }

    const { status, body } = await requestOAuthToken(ONEDRIVE_TOKEN_URL, {
      client_id: getCredentials().onedrive.client_id,
      client_secret: getCredentials().onedrive.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: getOneDriveScope(),
    });
    if (status === 401 || body.error === "invalid_grant") {
      await this.revoke();
      return undefined;
    }
    if (body.error || !body.access_token) {
      return undefined;
    }

    await UserSettings.updateItems();
    UserSettings.items.oneDriveToken = body.access_token;
    if (body.refresh_token) {
      // Microsoft rotates refresh tokens
      UserSettings.items.oneDriveRefreshToken = body.refresh_token;
    }
    await UserSettings.commitItems();
    return body.access_token;
  }

  private async revoke() {
    await UserSettings.updateItems();
    UserSettings.items.oneDriveToken = undefined;
    UserSettings.items.oneDriveRefreshToken = undefined;
    UserSettings.items.oneDriveRevoked = true;
    await UserSettings.commitItems();
  }

  async upload(encryption: EncryptionInterface) {
    await UserSettings.updateItems();
    if (UserSettings.items.oneDriveEncrypted === undefined) {
      UserSettings.items.oneDriveEncrypted = true;
      await UserSettings.commitItems();
    }
    const exportData = await EntryStorage.backupGetExport(
      encryption,
      UserSettings.items.oneDriveEncrypted === true
    );
    const backup = JSON.stringify(exportData, null, 2);

    const response = await this.authorizedFetch(
      `${GRAPH_API}/me/drive/special/approot:/${backupFileName()}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: backup,
      }
    );
    if (!response) {
      return false;
    }
    const res = await response.json().catch(() => ({}));
    if (!response.ok || !res.id) {
      logApiError(response, res);
      return false;
    }
    return true;
  }

  async getUser() {
    try {
      const response = await this.authorizedFetch(`${GRAPH_API}/me/`);
      if (!response) {
        return "Error: Access revoked or expired.";
      }
      const res = await response.json();
      if (!response.ok || !res.userPrincipalName) {
        logApiError(response, res);
        return "Error";
      }
      return res.userPrincipalName as string;
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}
