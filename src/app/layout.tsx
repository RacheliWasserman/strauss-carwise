import './globals.css';
import '@/components/ui/carwise-car-loader.css';
export const metadata={title:'יועץ הרכב של שטראוס',description:'סימולציית שכר והשוואת רכב לפי כללי אתגר שטראוס'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="he" dir="rtl"><body>{children}</body></html>}
