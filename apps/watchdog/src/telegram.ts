//! Telegram Bot API: sendMessage to one chat.

export interface Telegram {
  send(text: string): Promise<void>;
}

export function telegram(token: string, chatId: string, fetchFn: typeof fetch = fetch): Telegram {
  return {
    async send(text: string) {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`telegram: HTTP ${response.status} ${await response.text().catch(() => "")}`);
    },
  };
}
