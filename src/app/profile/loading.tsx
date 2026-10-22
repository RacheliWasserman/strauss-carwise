import '@/components/chat/employee-chat.css';
import '@/components/profile/profile.css';
import { CarWiseCarLoader } from '@/components/ui/carwise-car-loader';

/** Shown at once while the profile, the official roles and the catalog load on the server. */
export default function ProfileLoading() {
  return <main className="cw-app cw-profile-app" dir="rtl" aria-busy="true">
    <div className="cw-workspace">
      <div className="cw-profile-scroll">
        <div className="cw-profile">
          <CarWiseCarLoader variant="inline" label="הפרופיל שלך נטען..." className="cw-profile-loading" />
          <div className="cw-profile-skeleton cw-profile-skeleton-hero" aria-hidden="true" />
          {[0, 1, 2].map(index => <div key={index} className="cw-profile-skeleton" aria-hidden="true" />)}
        </div>
      </div>
    </div>
  </main>;
}
