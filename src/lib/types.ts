
export type Group = 'א' | 'ב' | 'ג' | 'ד';

export type Car = {
  'מזהה': string;
  'קבוצה': Group | 'משפחתי';
  'תוצר': string;
  'קוד תוצר': string;
  'דגם (כינוי מסחרי)': string;
  'קוד דגם': string;
  'תאור דגם': string;
  'שנת רישום': number;
  'הנעה': string;
  'מחיר מחירון': number;
  'שווי שימוש חודשי': number;
  'עלות חודשית לחברה (דמה)': number;
  'השתתפות עובד ברירת מחדל (דמה)': number;
};

export type Occupation = {
  'עיסוק': string;
  'קבוצת זכאות': Group;
  'רכב חובה': string;
  'מותר לוותר': string;
  'אחזקת רכב בוויתור (₪)': number;
};

export type Employee = {
  'מזהה': string;
  'שם': string;
  'ת״ז (פיקטיבית)': string;
  'עיסוק': string;
  'קבוצה': Group;
  'שכר בסיס': number;
  'עמלות': number;
  'בונוס': number;
  'פנסיה עובד %': number;
  'קרן השתלמות עובד %': number;
  'נקודות זיכוי': number;
  'ילדים עד 23': number;
  'רכב היום'?: string;
  currentVehicleId?: string | null;
  'השתתפות היום': number;
  'השאלה': string;
};

export type Reference = {
  'מזהה': string;
  'שם': string;
  'היום': string;
  'החלופה': string;
  'זכאות': string;
  'סיבה': string;
  'נטו היום': number;
  'נטו בחלופה': number;
  'הפרש': number;
  'מס היום': number;
  'מס בחלופה': number;
  'ביטוח לאומי+בריאות היום': number;
  'ביטוח לאומי+בריאות בחלופה': number;
  'החזר חשמל ברוטו': number;
  'חלק העובד במסלול המשפחתי': number;
  'למה': string;
};
