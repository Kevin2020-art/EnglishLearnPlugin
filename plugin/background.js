chrome.action.onClicked.addListener(async () => {
  const playerUrl = chrome.runtime.getURL("player.html");
  const tabs = await chrome.tabs.query({ url: playerUrl });

  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: playerUrl });
  }
});

