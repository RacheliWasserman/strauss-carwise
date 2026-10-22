'use client';

import Image from 'next/image';
import { useState } from 'react';
import { vehiclePhoto } from '../../lib/catalog/vehicle-media';
import type { ShowroomVehicle } from '../../lib/catalog/showroom';
import { CarWiseMark } from '../chat/chat-icon';

/**
 * Owner-supplied concept illustration, or a fallback if its asset is missing or fails to load.
 * Never substitutes another vehicle's illustration or claims verified visual accuracy.
 */
export function VehiclePhoto({ vehicle, sizes, priority = false, large = false }: {
  vehicle: ShowroomVehicle; sizes: string; priority?: boolean; large?: boolean;
}) {
  const photo = vehiclePhoto(vehicle.id);
  const [failed, setFailed] = useState(false);
  if (!photo || failed) {
    return <div className={`cw-photo-fallback ${large ? 'cw-photo-fallback-large' : ''}`} role="img"
      aria-label={`${vehicle.display_name}: אין תמונה מאומתת של הדגם`} data-fallback="true">
      <span className="cw-photo-fallback-mark" aria-hidden="true"><CarWiseMark small /></span>
      <strong dir="ltr">{vehicle.display_name}</strong>
      <span>קטלוג החברה · תמונת הדגם אינה זמינה</span>
    </div>;
  }
  return <Image src={photo.src} alt={`${vehicle.display_name} — ${photo.shows}`} fill sizes={sizes} priority={priority}
    className="cw-photo-image" onError={() => setFailed(true)} />;
}
