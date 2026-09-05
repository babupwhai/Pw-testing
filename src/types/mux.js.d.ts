declare module "mux.js" {
  export type TransmuxerSegment = {
    initSegment: Uint8Array;
    data: Uint8Array;
  };

  export class Transmuxer {
    constructor(options?: { remux?: boolean; keepOriginalTimestamps?: boolean });
    on(event: "data" | "done", handler: (segment: TransmuxerSegment) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }

  const muxjs: {
    mp4: {
      Transmuxer: typeof Transmuxer;
    };
  };

  export default muxjs;
}
