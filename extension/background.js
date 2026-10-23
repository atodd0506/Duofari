// Asks the containing app for the device's real screen size once per Safari
// session and stores it for the content scripts.
//
// Pages normally see iPhone Duo's 466 × 678 pt screen through window.screen,
// but Safari's Advanced Fingerprinting Protection (on by default in Private
// Browsing) reports a generic size instead. The app knows the truth.

const api = globalThis.browser || globalThis.chrome;

async function refreshDevice() {
  if (!api || !api.runtime || !api.runtime.sendNativeMessage) return;
  try {
    const reply = await api.runtime.sendNativeMessage('application.id', { type: 'device' });
    if (reply && reply.screenWidth > 0 && reply.screenHeight > 0) {
      await api.storage.local.set({
        device: {
          screenWidth: reply.screenWidth,
          screenHeight: reply.screenHeight,
          scale: reply.scale || 0,
          model: reply.model || '',
          checked: Date.now(),
        },
      });
    }
  } catch (error) {
    console.warn('[Duofari] could not ask the app about the device', error);
  }
}

api.runtime.onInstalled.addListener(refreshDevice);
api.runtime.onStartup.addListener(refreshDevice);
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'duofari:refresh-device') {
    refreshDevice().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
