/**
 * The name used to greet an employee: the first-name field exactly as entered, so compound first names stay whole
 * ("בת שבע", "שירה-לי", "אנה מריה"). Only a field that clearly holds a full name (three or more words) is shortened
 * to its first word.
 */
export function greetingName(firstName: string): string {
  const name = firstName.replace(/\s+/g, ' ').trim();
  if (!name) return '';
  const words = name.split(' ');
  return (words.length >= 3 ? words[0] : name).slice(0, 30);
}

/** "שלום רחלי 👋", or a neutral greeting when no name is stored. */
export const greeting = (firstName?: string) => firstName ? `שלום ${firstName} 👋` : 'שלום 👋';
