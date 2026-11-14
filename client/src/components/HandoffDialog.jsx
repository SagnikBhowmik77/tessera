import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Modal } from './ui.jsx';

// Reassigning a ticket that already has an owner: a short note so the new person isn't
// starting from zero. Optional. If the new person is busy, the overload warning is shown
// here too, with the lightest teammate offered instead.
export default function HandoffDialog({ handoff, fromName, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  const [target, setTarget] = useState(null);
  useEffect(() => { setNote(''); setTarget(handoff ? { id: handoff.id, name: handoff.name } : null); }, [handoff]);
  if (!handoff || !target) return null;
  const switched = target.id !== handoff.id;
  const go = () => onConfirm(target.id, note.trim());
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Hand over to ${target.name}`}
      footer={(
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={go}>{note.trim() ? 'Hand over with note' : 'Hand over without a note'}</Button>
        </>
      )}
    >
      <label className="block text-small">
        <span className="font-medium">Handoff note for {target.name}</span>
        <span className="block text-caption text-fg-subtle">
          What {fromName ? `${fromName} found` : 'is known'} so far, what was tried, where to look next. It is saved on the ticket and sent with the assignment.
        </span>
        <textarea
          className="input mt-2 min-h-28"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } }}
          placeholder="e.g. Only happens with saved cards. Logs are in the gateway dashboard; I suspect the retry loop."
        />
      </label>
      {handoff.message && !switched && (
        <p className="mt-3 flex gap-1.5 rounded-tile bg-warning/10 px-2.5 py-2 text-caption text-warning" role="status">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            {handoff.message}
            {handoff.alt && (
              <> <button type="button" className="font-semibold underline underline-offset-2"
                onClick={() => setTarget({ id: handoff.alt.member.user.id, name: handoff.alt.member.user.name })}>
                Hand to {handoff.alt.member.user.name} instead
              </button> ({handoff.alt.row.open} open).</>
            )}
          </span>
        </p>
      )}
    </Modal>
  );
}
