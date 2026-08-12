import { wordlist } from '@scure/bip39/wordlists/english.js';
import { SECRET_FIELD_PROPS } from './secretFieldProps';
import { SEED_WORD_COUNT } from '../lib/seed-words';

/**
 * The 12-word seed-phrase grid, extracted from the Restore screen so the
 * safebox PIN reset can reuse exactly the same entry behaviour (paste-splitting
 * a full phrase, per-word BIP39 validation on blur, case normalisation).
 *
 * The phrase is EPHEMERAL state owned by the PARENT: it is never persisted, and
 * the references are dropped when the parent unmounts. Physical zeroization of
 * JS memory is not achievable — consistent with the project-wide policy.
 */

interface SeedEntryGridProps {
  words: string[];
  onChange: (words: string[]) => void;
  invalidWords: boolean[];
  onInvalidChange: (invalid: boolean[]) => void;
  /** Cleared by the parent whenever the user edits anything. */
  onEdit?: () => void;
  disabled?: boolean;
}

export function SeedEntryGrid({
  words,
  onChange,
  invalidWords,
  onInvalidChange,
  onEdit,
  disabled,
}: SeedEntryGridProps) {
  function handleWordChange(index: number, value: string) {
    const trimmed = value.trim();
    // Paste of a full mnemonic (L2: normalize case — wallets often export
    // capitalized words, the BIP39 wordlist is lowercase-only).
    if (trimmed.includes(' ')) {
      const pasted = trimmed.split(/\s+/).map(w => w.toLowerCase());
      if (pasted.length === SEED_WORD_COUNT) {
        onChange(pasted);
        onInvalidChange(pasted.map(w => !wordlist.includes(w)));
        onEdit?.();
        return;
      }
    }
    const updated = [...words];
    updated[index] = trimmed.toLowerCase();
    onChange(updated);
    const nextInvalid = [...invalidWords];
    nextInvalid[index] = false;
    onInvalidChange(nextInvalid);
    onEdit?.();
  }

  /** UX-1.6: flag a word that is not in the BIP39 wordlist as soon as the
   *  field loses focus — before the full-phrase check on submit. */
  function handleWordBlur(index: number) {
    const w = words[index];
    const next = [...invalidWords];
    next[index] = !!w && !wordlist.includes(w);
    onInvalidChange(next);
  }

  return (
    <div className="seed-grid input-grid">
      {words.map((word, i) => (
        <div className="seed-word-input" key={i}>
          <span className="seed-num">{i + 1}</span>
          <input
            type="text"
            className={invalidWords[i] ? 'invalid' : undefined}
            value={word}
            onChange={e => handleWordChange(i, e.target.value)}
            onBlur={() => handleWordBlur(i)}
            placeholder="..."
            disabled={disabled}
            autoCapitalize="none"
            spellCheck={false}
            aria-label={`Слово ${i + 1} из 12`}
            aria-invalid={invalidWords[i] || undefined}
            {...SECRET_FIELD_PROPS}
          />
        </div>
      ))}
    </div>
  );
}
