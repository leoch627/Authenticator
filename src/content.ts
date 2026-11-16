// @ts-expect-error - no typings
import QRCode from "qrcode-reader";
import jsQR from "jsqr";

// @ts-expect-error - injected by vue-svg-loader
import scanGIF from "../images/scan.gif";

// The host page shares the DOM with this script, but not its variables.
// Everything a scan relies on is kept here, out of the page's reach; the
// overlay elements are the only part of it the page can see or touch.
let grayLayout: HTMLDivElement | undefined;
let captureBox: HTMLDivElement | undefined;
let scan: HTMLDivElement | undefined;
// True only between a scan request from the extension and its end
let scanning = false;
let captureBoxPositionLeft = 0;
let captureBoxPositionTop = 0;

// This script is injected again every time it is needed. Tear down the
// previous instance so that only one of them handles messages and owns the
// overlay.
const contentGlobal = globalThis as typeof globalThis & {
  __gaDisposeContentScript?: () => void;
};
contentGlobal.__gaDisposeContentScript?.();
contentGlobal.__gaDisposeContentScript = () => {
  scanning = false;
  grayLayout?.remove();
  window.removeEventListener("keydown", onKeyDown, true);
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch (error) {
    // The extension was reloaded, the listener is already gone
  }
};

chrome.runtime.onMessage.addListener(onMessage);
window.addEventListener("keydown", onKeyDown, true);

function onMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) {
  switch (message.action) {
    case "capture":
      sendResponse("beginCapture");
      showGrayLayout();
      break;
    case "sendCaptureUrl":
      qrDecode(
        message.info.url,
        message.info.captureBoxLeft,
        message.info.captureBoxTop,
        message.info.captureBoxWidth,
        message.info.captureBoxHeight
      );
      break;
    case "errorsecret":
      alert(chrome.i18n.getMessage("errorsecret") + message.secret);
      break;
    case "errorenc":
      alert(chrome.i18n.getMessage("phrase_incorrect"));
      break;
    case "added":
      alert(message.account + chrome.i18n.getMessage("added"));
      break;
    case "text":
      alert(message.text);
      break;
    case "migrationfail":
      alert(chrome.i18n.getMessage("migration_fail"));
      break;
    case "migrationpartlyfail":
      alert(chrome.i18n.getMessage("migration_partly_fail"));
      break;
    case "migrationsuccess":
      alert(chrome.i18n.getMessage("updateSuccess"));
      break;
    case "pastecode":
      pasteCode(message.code);
      break;
    case "stopCapture":
      hideGrayLayout();
      break;
    default:
      // invalid command, ignore it
      break;
  }

  // https://stackoverflow.com/a/56483156
  return true;
}

function showGrayLayout() {
  if (!grayLayout) {
    // An instance we could not tear down may have left its overlay behind
    document.getElementById("__ga_grayLayout__")?.remove();

    grayLayout = document.createElement("div");
    grayLayout.id = "__ga_grayLayout__";
    document.body.appendChild(grayLayout);
    scan = document.createElement("div");
    scan.className = "scan";
    scan.id = "__ga_scan__";
    grayLayout.appendChild(scan);
    captureBox = document.createElement("div");
    captureBox.id = "__ga_captureBox__";
    grayLayout.appendChild(captureBox);
    grayLayout.addEventListener("mousedown", grayLayoutDown);
    grayLayout.addEventListener("mousemove", grayLayoutMove);
    grayLayout.addEventListener("mouseup", grayLayoutUp);
    grayLayout.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }
  if (scan) {
    scan.style.background = `url('${scanGIF}') no-repeat center`;
  }
  captureBoxPositionLeft = 0;
  captureBoxPositionTop = 0;
  grayLayout.style.display = "block";
  scanning = true;
}

function hideGrayLayout() {
  scanning = false;
  if (captureBox) {
    captureBox.style.display = "none";
  }
  if (grayLayout) {
    grayLayout.style.display = "none";
  }
}

// The page can show the overlay or dispatch events on it by itself. Only
// follow the mouse while a scan started by the extension is running, and
// only when the event comes from the user.
function isScanEvent(event: Event) {
  return scanning && event.isTrusted;
}

function grayLayoutDown(event: MouseEvent) {
  if (!isScanEvent(event)) {
    return;
  }
  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }
  if (!captureBox) {
    return;
  }

  captureBoxPositionLeft = event.clientX;
  captureBoxPositionTop = event.clientY;
  captureBox.style.left = event.clientX + "px";
  captureBox.style.top = event.clientY + "px";
  captureBox.style.width = "1px";
  captureBox.style.height = "1px";
  captureBox.style.display = "block";

  if (scan) {
    scan.style.background = "transparent";
  }
  return;
}

function grayLayoutMove(event: MouseEvent) {
  if (!isScanEvent(event)) {
    return;
  }
  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }
  if (!captureBox) {
    return;
  }

  const captureBoxLeft = Math.min(captureBoxPositionLeft, event.clientX);
  const captureBoxTop = Math.min(captureBoxPositionTop, event.clientY);
  const captureBoxWidth = Math.abs(captureBoxPositionLeft - event.clientX) - 1;
  const captureBoxHeight = Math.abs(captureBoxPositionTop - event.clientY) - 1;
  captureBox.style.left = captureBoxLeft + "px";
  captureBox.style.top = captureBoxTop + "px";
  captureBox.style.width = captureBoxWidth + "px";
  captureBox.style.height = captureBoxHeight + "px";
  return;
}

function grayLayoutUp(event: MouseEvent) {
  if (!isScanEvent(event)) {
    return;
  }
  // A scan takes a single screenshot
  scanning = false;

  setTimeout(hideGrayLayout, 100);

  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }

  const captureBoxLeft = Math.min(captureBoxPositionLeft, event.clientX) + 1;
  const captureBoxTop = Math.min(captureBoxPositionTop, event.clientY) + 1;
  const captureBoxWidth = Math.abs(captureBoxPositionLeft - event.clientX) - 1;
  const captureBoxHeight = Math.abs(captureBoxPositionTop - event.clientY) - 1;

  // make sure captureBox and grayLayout is hidden
  setTimeout(() => {
    chrome.runtime.sendMessage({
      action: "getCapture",
      info: {
        captureBoxLeft,
        captureBoxTop,
        captureBoxWidth,
        captureBoxHeight,
      },
    });
  }, 200);
}

async function qrDecode(
  url: string,
  left: number,
  top: number,
  width: number,
  height: number
) {
  // The screenshot shows more than this page may read, such as frames from
  // other sites. Keep the canvas out of the DOM so the page cannot get to it.
  const canvas = document.createElement("canvas");
  const qr = new Image();
  qr.onload = () => {
    const devicePixelRatio = qr.width / window.innerWidth;
    canvas.width = qr.width;
    canvas.height = qr.height;
    canvas.getContext("2d")?.drawImage(qr, 0, 0);
    const imageData = canvas
      .getContext("2d")
      ?.getImageData(
        left * devicePixelRatio,
        top * devicePixelRatio,
        width * devicePixelRatio,
        height * devicePixelRatio
      );
    if (imageData) {
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.getContext("2d")?.putImageData(imageData, 0, 0);

      const qrReader = new QRCode();
      qrReader.callback = (
        error: string,
        text: {
          result: string;
          points: Array<{
            x: number;
            y: number;
            count: number;
            estimatedModuleSize: number;
          }>;
        }
      ) => {
        let qrRes = "";
        if (error) {
          console.error(error);
          const jsQrCode = jsQR(
            imageData.data,
            imageData.width,
            imageData.height
          );

          if (jsQrCode) {
            qrRes = jsQrCode.data;
          } else {
            alert(chrome.i18n.getMessage("errorqr"));
          }
        } else {
          qrRes = text.result;
        }

        chrome.runtime.sendMessage({
          action: "getTotp",
          info: qrRes,
        });
      };
      qrReader.decode(imageData);
    }
  };
  qr.src = url;
}

function pasteCode(code: string) {
  const _inputBoxes = document.getElementsByTagName("input");
  const inputBoxes: HTMLInputElement[] = [];
  for (let i = 0; i < _inputBoxes.length; i++) {
    if (
      _inputBoxes[i].type === "text" ||
      _inputBoxes[i].type === "number" ||
      _inputBoxes[i].type === "tel" ||
      _inputBoxes[i].type === "password"
    ) {
      inputBoxes.push(_inputBoxes[i]);
    }
  }
  if (!inputBoxes.length) {
    return;
  }
  const identities = [
    "2fa",
    "otp",
    "authenticator",
    "factor",
    "code",
    "totp",
    "twoFactorCode",
  ];
  for (const inputBox of inputBoxes) {
    for (const identity of identities) {
      if (
        inputBox.name.toLowerCase().indexOf(identity) >= 0 ||
        inputBox.id.toLowerCase().indexOf(identity) >= 0
      ) {
        if (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) {
          inputBox.value = code;
          fireInputEvents(inputBox);
        }
        return;
      }
    }
  }

  const activeInputBox =
    document.activeElement && document.activeElement.tagName === "INPUT"
      ? document.activeElement
      : null;
  if (activeInputBox) {
    const inputBox = activeInputBox as HTMLInputElement;
    if (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) {
      inputBox.value = code;
      fireInputEvents(inputBox);
    }
    return;
  }

  for (const inputBox of inputBoxes) {
    if (
      (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) &&
      inputBox.type !== "password"
    ) {
      inputBox.value = code;
      fireInputEvents(inputBox);
      return;
    }
  }
  return;
}

function fireInputEvents(inputBox: HTMLInputElement) {
  const events = [
    new KeyboardEvent("keydown"),
    new KeyboardEvent("keyup"),
    new KeyboardEvent("keypress"),
    new Event("input", { bubbles: true }),
    new Event("change", { bubbles: true }),
  ];
  for (const event of events) {
    inputBox.dispatchEvent(event);
  }
  return;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && isScanEvent(event)) {
    event.preventDefault();
    hideGrayLayout();
  }
}
