'use client';

import { useEffect, useId, useRef } from 'react';
import type { ShowroomVehicle } from '../../lib/catalog/showroom';
import { ChatIcon } from '../chat/chat-icon';
import { VehiclePhoto } from './vehicle-photo';

/** Native modal supplies focus containment and Escape; focus returns to the zoom control. */
export function VehicleImageViewer({ vehicle, onClose }: { vehicle: ShowroomVehicle; onClose: () => void }) {
  const dialog=useRef<HTMLDialogElement>(null);
  const title=useId();
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.showModal();
    return ()=>previous?.focus();
  },[]);
  return <dialog ref={dialog} className="cw-image-viewer" dir="rtl" aria-labelledby={title}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}
    onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}}
    onClick={event=>{if(event.target===dialog.current)onClose();}}>
    <header><h2 id={title}><bdi dir="ltr">{vehicle.display_name}</bdi></h2>
      <button type="button" className="cw-vehicle-dialog-close" aria-label="סגירת התמונה המוגדלת" onClick={onClose}><ChatIcon name="close" /></button>
    </header>
    <div className="cw-image-viewer-stage"><VehiclePhoto key={vehicle.id} vehicle={vehicle} sizes="(max-width: 800px) 90vw, 900px" large /></div>
    <p>תמונה להמחשת הדגם · פרטי הצילום והרישיון בחלון פרטי הרכב</p>
  </dialog>;
}
