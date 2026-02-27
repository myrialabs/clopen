// Global window extensions for cursor tracking
declare global {
  interface Window {
    __cursorInfo?: {
      cursor: string;
      x: number;
      y: number;
      timestamp: number;
    };
  }
}

export {};