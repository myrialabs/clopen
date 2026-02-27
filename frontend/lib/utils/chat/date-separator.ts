import type { SDKMessageFormatter } from '$shared/types/database/schema';

// Interface for date separator items
export interface DateSeparatorItem {
  type: 'message' | 'date';
  data: any;
  key: string;
}

// Add date separators to messages
// startIndex: global offset for stable keys when using windowed slices
export function addDateSeparators(messages: SDKMessageFormatter[], startIndex: number = 0): DateSeparatorItem[] {
  const result: DateSeparatorItem[] = [];
  let lastDate: string | null = null;

  messages.forEach((message, index) => {
    const createdAt = message.metadata?.created_at || new Date().toISOString();
    const messageDate = new Date(createdAt).toDateString();

    // Add date separator if date has changed
    if (messageDate !== lastDate) {
      result.push({
        type: 'date',
        data: createdAt,
        key: `date-${messageDate}`
      });
      lastDate = messageDate;
    }

    // Use global index for stable keys across window shifts
    result.push({
      type: 'message',
      data: message,
      key: `message-${startIndex + index}`
    });
  });

  return result;
}