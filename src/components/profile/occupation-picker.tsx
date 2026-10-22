'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { ChatIcon } from '../chat/chat-icon';

export type PickerOccupation = { key: string; title: string };

/** "נציג/ת מכירות" is found by "נציג", "נציגת", "מכירות" — slashes, geresh and spacing never block a match. */
export const occupationSearchText = (text: string) => text.normalize('NFC').toLocaleLowerCase().replace(/[/\\'"׳״\-–.,()]+/g, ' ').replace(/\s+/g, ' ').trim();
export function filterOccupations<T extends PickerOccupation>(occupations: T[], query: string): T[] {
  const words = occupationSearchText(query).split(' ').filter(Boolean);
  if (!words.length) return occupations;
  return occupations.filter(item => {
    const title = occupationSearchText(item.title);
    const compact = title.replace(/ /g, '');
    return words.every(word => title.includes(word) || compact.includes(word));
  });
}

/**
 * A searchable list of the official roles (ARIA combobox). Only an item from the list can be chosen: typed text
 * filters the list and is discarded if nothing is picked, so a free-text role can never be saved.
 */
export function OccupationPicker({ occupations, value, onChange, invalid, describedBy, disabled }: {
  occupations: PickerOccupation[]; value: string; onChange: (key: string) => void;
  invalid?: boolean; describedBy?: string; disabled?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const selected = occupations.find(item => item.key === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(() => filterOccupations(occupations, query), [occupations, query]);
  const choose = (item: PickerOccupation) => { onChange(item.key); setQuery(''); setOpen(false); };
  const openList = () => { setOpen(true); setActive(Math.max(0, shown.findIndex(item => item.key === value))); };
  const optionId = (index: number) => `${id}-option-${index}`;

  return <div className={`cw-occupation ${open ? 'cw-occupation-open' : ''}`}>
    <div className="cw-occupation-field">
      <ChatIcon name="search" />
      <input ref={input} type="text" role="combobox" dir="auto" autoComplete="off" disabled={disabled}
        aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={invalid || undefined} aria-describedby={describedBy}
        aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
        placeholder={selected ? selected.title : 'חיפוש תפקיד, למשל "מכירות" או "מהנדס"'}
        value={open ? query : selected?.title ?? ''}
        onFocus={openList} onClick={openList}
        onBlur={() => { setOpen(false); setQuery(''); }}
        onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); if (!open) openList(); else setActive(index => Math.min(shown.length - 1, index + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
          else if (event.key === 'Enter' && open) { event.preventDefault(); if (shown[active]) choose(shown[active]); }
          else if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); setQuery(''); }
        }} />
      <button type="button" className="cw-occupation-toggle" tabIndex={-1} aria-label={open ? 'סגירת רשימת התפקידים' : 'פתיחת רשימת התפקידים'}
        disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { input.current?.focus(); openList(); } }}>
        <ChatIcon name="down" />
      </button>
    </div>
    {open && <ul id={listId} role="listbox" className="cw-occupation-list" aria-label="תפקידים">
      {shown.length ? shown.map((item, index) => <li key={item.key} id={optionId(index)} role="option" aria-selected={item.key === value}
        className={`${index === active ? 'cw-occupation-active' : ''} ${item.key === value ? 'cw-occupation-chosen' : ''}`}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
        <span>{item.title}</span>{item.key === value && <ChatIcon name="check" />}
      </li>) : <li className="cw-occupation-none" role="presentation">לא נמצא תפקיד כזה ברשימה. אפשר לנסות מילה אחרת.</li>}
    </ul>}
    <span className="cw-sr-only" aria-live="polite">{open ? `${shown.length} תפקידים ברשימה` : ''}</span>
  </div>;
}
