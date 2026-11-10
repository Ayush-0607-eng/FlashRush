export type Sale={id:string;name:string;description:string;priceMinor:number;total:number;reserved:number;sold:number;available:number;maxPerSession:number;holdSeconds:number;startsAt:string;endsAt:string;status:'SCHEDULED'|'ACTIVE'|'SOLD_OUT'|'ENDED';serverTime:string}
export type Reservation={id:string;saleId:string;quantity:number;unitPriceMinor:number;totalMinor:number;status:'RESERVED'|'CONFIRMED'|'EXPIRED'|'CANCELLED';expiresAt:string;createdAt:string;resolvedAt:string|null}
export type Booking={reservation:Reservation;saleName:string;order:{id:string;totalMinor:number;paymentStatus:string;createdAt:string}|null}
const base='/api/v1'
async function request<T>(path:string, options:RequestInit={}):Promise<T>{
 const headers=new Headers(options.headers); headers.set('X-Requested-With','flashrush');
 if(options.body) headers.set('Content-Type','application/json')
 const response=await fetch(base+path,{...options,headers,credentials:'include'})
 const body=await response.json().catch(()=>({}))
 if(!response.ok){const err=body?.error;throw new Error(err?.message||`Request failed (${response.status})`)}
 return body as T
}
export const api={
 session:()=>request('/session',{method:'POST'}),
 sales:async()=> (await request<{data:Sale[]}>('/sales')).data,
 sale:async(id:string)=>(await request<{data:Sale}>(`/sales/${id}`)).data,
 reserve:async(id:string,quantity:number)=>request<{data:Reservation}>(`/sales/${id}/reservations`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({quantity})}),
 checkout:async(id:string,outcome:'success'|'fail')=>request<{data:{order:{id:string;totalMinor:number};reservation:Reservation}}>(`/reservations/${id}/checkout`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({outcome})}),
 cancel:async(id:string)=>(await request<{data:Reservation}>(`/reservations/${id}/cancel`,{method:'POST'})).data,
 reservation:async(id:string)=>(await request<{data:Reservation}>(`/reservations/${id}`)).data,
 bookings:async()=>(await request<{data:Booking[]}>('/bookings')).data,
 ready:()=>request<{status:string}>('/ready')
}
