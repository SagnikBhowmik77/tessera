import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ui.jsx';

// An in-app replacement for window.confirm: `if (!(await ask('Remove "x"? It stops at once.'))) return;`
// The first sentence becomes the dialog title, the rest its text. One host (in main.jsx) shows it.
let show = null;

export function ask(message, { confirmLabel } = {}) {
  if (!show) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => show({ message, confirmLabel, resolve }));
}

export function ConfirmHost() {
  const [req, setReq] = useState(null);
  useEffect(() => {
    show = setReq;
    return () => { show = null; };
  }, []);
  const finish = (ok) => { req?.resolve(ok); setReq(null); };
  const message = req?.message ?? '';
  const cut = message.search(/\n\n|[?.]\s/);
  const title = cut > 0 ? message.slice(0, message[cut] === '\n' ? cut : cut + 1) : message;
  const body = cut > 0 ? message.slice(cut + 2).trim() : '';
  return (
    <ConfirmDialog
      open={Boolean(req)}
      title={title}
      confirmLabel={req?.confirmLabel ?? title.split(' ')[0]}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    >
      {body}
    </ConfirmDialog>
  );
}
