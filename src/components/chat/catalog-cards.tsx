import type { CatalogMessage } from '@/lib/catalog-message';
import { ChatIcon } from './chat-icon';

/** Text a card's select button sends. It is an ordinary employee message, validated by the server like typed text. */
export const selectCardMessage = (card: CatalogMessage['cards'][number]) => `אני רוצה את ${card.display_name} (${card.id})`;

export function CatalogCards({ message, onSelect }: { message: CatalogMessage; onSelect?: (body: string) => void }) {
  if (!message.cards.length) return null;
  return <section className="cw-catalog" aria-label="רכבים מתוך קטלוג החברה" dir="rtl">
    <ul className="cw-catalog-grid">{message.cards.map(card => <li key={card.id} className="cw-catalog-card">
      <div className="cw-catalog-top"><ChatIcon name="car" /><span>קטלוג החברה</span></div>
      <h3 dir="auto">{card.display_name}</h3>
      <p dir="auto">{card.manufacturer_name}</p>
      <dl><div><dt>קבוצה</dt><dd>{card.group_code}</dd></div><div><dt>הנעה</dt><dd>{card.drive_type}</dd></div></dl>
      <small>מזהה קטלוג: <bdi>{card.id}</bdi></small>
      {onSelect && <button type="button" className="cw-card-select" onClick={() => onSelect(selectCardMessage(card))}
        aria-label={`בחירה ב־${card.display_name}`}>בחירה ברכב הזה</button>}
    </li>)}</ul>
    <p className="cw-catalog-caption">נתוני קטלוג שנשמרו בשיחה ב־<time dateTime={message.recordedAt}>{new Intl.DateTimeFormat('he-IL', { dateStyle: 'short' }).format(new Date(message.recordedAt))}</time>. {message.state.groupSource === 'occupation_match' ? 'רכבים מקטלוג החברה שמתאימים לתפקיד שמסרת.' : 'הסינון לפי קבוצה שנמסרה בשיחה; אינו אישור זכאות.'} הזמינות עשויה להשתנות.</p>
  </section>;
}
