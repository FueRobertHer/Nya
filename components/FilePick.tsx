// Choosing a file (docs/design/design-system.md, Field): Nya's own secondary
// button over a visually hidden file input, so the one control that was the
// browser's ("Choose File | No file chosen") looks like the rest, with its
// focus ring and its dimming on the button (app/globals.css). What is wrong
// with a file the person chose sits under it as a FieldError, named by the
// input (aria-invalid, aria-describedby) and said as it appears (role
// "alert"), since nothing in Nya is wrong. Focus comes back to the field
// with it, as the field may have been drawn again while the file was read
// (`inputKey`), so the button keeps the person's place.

import { useEffect, useId, useRef } from 'react';
import FieldError from './FieldError';

export default function FilePick({
  label = 'Choose a file',
  accept,
  inputKey,
  disabled,
  error,
  onPick,
}: {
  label?: string;
  accept: string;
  /** Moved on to clear the input, so the same file can be chosen again. */
  inputKey: number;
  disabled: boolean;
  /** What is wrong with the file chosen, or '' when nothing is. */
  error: string;
  onPick: (file: File | null) => void;
}) {
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error) input.current?.focus();
  }, [error, inputKey]);
  return (
    <div>
      <label className="btn secondary">
        {label}
        <input
          key={inputKey}
          ref={input}
          type="file"
          className="visually-hidden"
          accept={accept}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
      </label>
      <div role="alert">{error && <FieldError id={errorId}>{error}</FieldError>}</div>
    </div>
  );
}
