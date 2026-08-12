import { useState } from 'react';
import {
  RANDOM_MIN_LENGTH,
  RANDOM_MAX_LENGTH,
  RANDOM_DEFAULT_LENGTH,
  PASSPHRASE_DEFAULT_WORDS,
  PASSPHRASE_MIN_WORDS,
  PASSPHRASE_MAX_WORDS,
  CHARSET_LOWER,
  CHARSET_UPPER,
  CHARSET_DIGITS,
  CHARSET_SYMBOLS,
  generateRandomPassword,
  generatePassphrase,
} from '../lib/password-gen';

/** Generator UI. The randomness itself (rejection sampling, the passphrase
 *  policy) lives in lib/password-gen.ts and is unit-tested there. */

interface PasswordGeneratorProps {
  onGenerate: (password: string) => void;
}

export function PasswordGenerator({ onGenerate }: PasswordGeneratorProps) {
  const [mode, setMode] = useState<'random' | 'passphrase'>('random');
  const [length, setLength] = useState(RANDOM_DEFAULT_LENGTH);
  const [words, setWords] = useState(PASSPHRASE_DEFAULT_WORDS);
  const [useUpper, setUseUpper] = useState(true);
  const [useDigits, setUseDigits] = useState(true);
  const [useSymbols, setUseSymbols] = useState(true);

  function build() {
    if (mode === 'passphrase') {
      onGenerate(generatePassphrase(words));
      return;
    }
    const alphabet = CHARSET_LOWER
      + (useUpper ? CHARSET_UPPER : '')
      + (useDigits ? CHARSET_DIGITS : '')
      + (useSymbols ? CHARSET_SYMBOLS : '');
    onGenerate(generateRandomPassword(length, alphabet));
  }

  return (
    <div className="pwgen">
      <div className="pwgen-modes" role="group" aria-label="Тип пароля">
        <button
          type="button"
          className={`theme-option ${mode === 'random' ? 'theme-option--active' : ''}`}
          aria-pressed={mode === 'random'}
          onClick={() => setMode('random')}
        >
          Случайный
        </button>
        <button
          type="button"
          className={`theme-option ${mode === 'passphrase' ? 'theme-option--active' : ''}`}
          aria-pressed={mode === 'passphrase'}
          onClick={() => setMode('passphrase')}
        >
          Из слов
        </button>
      </div>

      {mode === 'random' ? (
        <>
          <label className="pwgen-length">
            Длина: <strong>{length}</strong>
            <input
              type="range"
              min={RANDOM_MIN_LENGTH}
              max={RANDOM_MAX_LENGTH}
              value={length}
              onChange={e => setLength(Number(e.target.value))}
              aria-label="Длина пароля"
            />
          </label>
          <div className="pwgen-sets">
            <label className="checkbox-label">
              <input type="checkbox" checked={useUpper} onChange={e => setUseUpper(e.target.checked)} />
              <span>A–Z</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={useDigits} onChange={e => setUseDigits(e.target.checked)} />
              <span>0–9</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={useSymbols} onChange={e => setUseSymbols(e.target.checked)} />
              <span>!@#</span>
            </label>
          </div>
        </>
      ) : (
        <label className="pwgen-length">
          Слов: <strong>{words}</strong>
          <input
            type="range"
            min={PASSPHRASE_MIN_WORDS}
            max={PASSPHRASE_MAX_WORDS}
            value={words}
            onChange={e => setWords(Number(e.target.value))}
            aria-label="Количество слов"
          />
          <span className="settings-hint">
            {words} слов из 2048 ≈ {Math.round(words * Math.log2(2048))} бит энтропии
          </span>
        </label>
      )}

      <button type="button" className="btn btn-outline full-width" onClick={build}>
        🎲 Сгенерировать пароль
      </button>
    </div>
  );
}
