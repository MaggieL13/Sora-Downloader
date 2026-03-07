let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: "popup.html",
    type: "popup",
    width: 440,
    height: 640
  });
  popupWindowId = win.id;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});
