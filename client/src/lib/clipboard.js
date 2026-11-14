import toast from 'react-hot-toast';

// Copies text and says so only if it really worked. Browsers can refuse clipboard access
// (permissions, an embedded page, an insecure origin); then the person is told, and short
// text is shown so it can still be copied by hand.
export async function copyText(text, success) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast.success(success);
    return true;
  } catch {
    toast.error(text.length <= 160
      ? `Your browser blocked copying. Here it is to copy by hand: ${text}`
      : 'Your browser blocked copying. Select the text and press Ctrl+C instead.', { duration: 8000 });
    return false;
  }
}
