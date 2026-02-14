const tokenInput = document.getElementById("token");
const saveButton = document.getElementById("save");
const validateButton = document.getElementById("validate");
const status = document.getElementById("status");

init();

function init() {
  saveButton.addEventListener("click", onSave);
  validateButton.addEventListener("click", onValidate);
  loadToken();
}

async function loadToken() {
  setStatus("", "");
  try {
    const response = await sendMessage({ type: "getToken" });
    if (!response.ok) {
      throw new Error(response.error || "Unable to load token.");
    }

    tokenInput.value = response.token || "";
  } catch (error) {
    setStatus(stringifyError(error), "error");
  }
}

async function onSave() {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Token is empty.", "error");
    return;
  }

  try {
    const response = await sendMessage({ type: "saveToken", token });
    if (!response.ok) {
      throw new Error(response.error || "Unable to save token.");
    }

    setStatus("Token saved.", "ok");
  } catch (error) {
    setStatus(stringifyError(error), "error");
  }
}

async function onValidate() {
  setStatus("Validating...", "");

  try {
    const response = await sendMessage({ type: "validateToken" });
    if (!response.ok) {
      throw new Error(response.error || "Validation failed.");
    }

    const login = response.login ? ` as ${response.login}` : "";
    setStatus(`Token looks valid${login}.`, "ok");
  } catch (error) {
    setStatus(stringifyError(error), "error");
  }
}

function setStatus(message, kind) {
  status.textContent = message;
  status.classList.remove("ok", "error");
  if (kind) {
    status.classList.add(kind);
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function stringifyError(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch (_) {
    return "Unknown error";
  }
}
