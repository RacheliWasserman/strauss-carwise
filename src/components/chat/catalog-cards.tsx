'use client';

import { useState } from 'react';
import {shouldRenderCatalog,type CatalogMessage} from '../../lib/catalog-message';
import { ChatIcon } from './chat-icon';

type Card = CatalogMessage['cards'][number];
/** One comparison holds at most 6 cars (the calculation result block's limit). */
export const MAX_COMPARE = 6;
/** Text a card's select button sends. It is an ordinary employee message, validated by the server like typed text. */
export const selectCardMessage = (card: Card) => `אני רוצה את ${card.display_name} (${card.id})`;
/** Text the comparison bar sends for several chosen cars; the server resolves the catalog IDs. */
export const compareCardsMessage = (cards: Card[]) => cards.length === 1 ? selectCardMessage(cards[0])
  : `אני רוצה להשוות את: ${cards.map(card => `${card.display_name} (${card.id})`).join(', ')}`;

export function CatalogCards({ message, onSelect }: { message: CatalogMessage; onSelect?: (body: string) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  if (!shouldRenderCatalog(message)) return null;
  const toggle = (id: string) => setChosen(current => current.includes(id) ? current.filter(item => item !== id)
    : current.length >= MAX_COMPARE ? current : [...current, id]);
  const picked = message.cards.filter(card => chosen.includes(card.id));
  return <section className="cw-catalog" aria-label="רכבים מתוך קטלוג החברה" dir="rtl">
    <ul className="cw-catalog-grid">{message.cards.map(card => <li key={card.id} className={`cw-catalog-card ${chosen.includes(card.id) ? 'cw-catalog-card-chosen' : ''}`}>
      <div className="cw-catalog-top"><ChatIcon name="car" /><span>קטלוג החברה</span></div>
      <h3 dir="auto">{card.display_name}</h3>
      <p dir="auto">{card.manufacturer_name}</p>
      <dl><div><dt>קבוצה</dt><dd>{card.group_code}</dd></div><div><dt>הנעה</dt><dd>{card.drive_type}</dd></div></dl>
      <small>מזהה קטלוג: <bdi>{card.id}</bdi></small>
      {onSelect && <div className="cw-card-controls">
        <label className="cw-card-compare">
          <input type="checkbox" checked={chosen.includes(card.id)} onChange={() => toggle(card.id)}
            disabled={!chosen.includes(card.id) && chosen.length >= MAX_COMPARE} />
          <span>להשוואה</span>
        </label>
        <button type="button" className="cw-card-select" onClick={() => onSelect(selectCardMessage(card))}
          aria-label={`בחירה ב־${card.display_name}`}>בחירה ברכב הזה</button>
      </div>}
    </li>)}</ul>
    {onSelect && message.cards.length > 1 && <div className="cw-compare-bar" role="group" aria-label="השוואה בין רכבים">
      <span aria-live="polite">{picked.length ? `נבחרו ${picked.length} מתוך עד ${MAX_COMPARE}` : `אפשר לסמן עד ${MAX_COMPARE} רכבים ולהשוות ביניהם`}</span>
      <button type="button" disabled={!picked.length} onClick={() => onSelect(compareCardsMessage(picked))}>
        {picked.length > 1 ? `השוואה בין ${picked.length} רכבים` : 'השוואה'}
      </button>
    </div>}
    <p className="cw-catalog-caption">נתוני קטלוג שנשמרו בשיחה ב־<time dateTime={message.recordedAt}>{new Intl.DateTimeFormat('he-IL', { dateStyle: 'short' }).format(new Date(message.recordedAt))}</time>. {message.state.groupSource === 'occupation_match' ? 'רכבים מקטלוג החברה שמתאימים לתפקיד שמסרת.' : 'הסינון לפי קבוצה שנמסרה בשיחה; אינו אישור זכאות.'} הזמינות עשויה להשתנות.</p>
  </section>;
}
