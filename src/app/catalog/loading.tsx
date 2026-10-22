import '@/components/chat/employee-chat.css';
import '@/components/catalog/catalog.css';
import { CarWiseCarLoader } from '@/components/ui/carwise-car-loader';

/** Shown while the catalog and personal eligibility load on the server. */
export default function CatalogLoading() {
  return <main className="cw-app cw-catalog-app" dir="rtl" aria-busy="true">
    <div className="cw-workspace">
      <div className="cw-showroom-scroll">
        <div className="cw-showroom">
          <CarWiseCarLoader variant="catalog" />
          <div className="cw-skeleton cw-skeleton-hero" aria-hidden="true" />
          <div className="cw-skeleton cw-skeleton-bar" aria-hidden="true" />
          <ul className="cw-showroom-grid" style={{ marginTop: 34 }} aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map(index => <li key={index}><div className="cw-skeleton-card" style={{ flex: 1 }}>
              <div className="cw-skeleton" />
              <div className="cw-skeleton-lines"><div className="cw-skeleton" style={{ height: 24, width: '55%' }} /><div className="cw-skeleton" style={{ height: 14, width: '35%' }} />
                <div className="cw-skeleton" style={{ height: 62 }} /><div className="cw-skeleton" style={{ height: 48 }} /></div>
            </div></li>)}
          </ul>
        </div>
      </div>
    </div>
  </main>;
}
