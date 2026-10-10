export type TimelinePoint={timestamp_seconds:number;visible_ants:number;activity_index:number};
export const timestampFromOffset=(offset:number,width:number,duration:number)=>Math.max(0,Math.min(duration,(offset/width)*duration));
