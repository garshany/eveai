// Чистая логика прокрутки чат-треда. DOM-элемент описан структурным типом,
// чтобы модуль тестировался в node-окружении без jsdom.

export type ChatScrollBehavior = 'instant' | 'smooth';

export type ChatScrollContainer = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo?: (options: { top: number; behavior: ChatScrollBehavior }) => void;
};

export const SCROLL_PIN_THRESHOLD_PX = 90;

// Первичная загрузка истории должна попадать в конец мгновенно — плавная
// прокрутка через весь тред выглядит как перелистывание чужого диалога.
export function decideScrollBehavior(isInitialLoad: boolean): ChatScrollBehavior {
  return isInitialLoad ? 'instant' : 'smooth';
}

export function isPinnedToBottom(
  container: Pick<ChatScrollContainer, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  thresholdPx: number = SCROLL_PIN_THRESHOLD_PX,
): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < thresholdPx;
}

// Докручивает до самого низа контейнера: scrollHeight гарантированно включает
// последнее сообщение и нижний padding треда, в отличие от scrollIntoView
// по якорю, который может остановиться выше из-за отступов.
export function scrollToBottom(container: ChatScrollContainer, behavior: ChatScrollBehavior): void {
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: container.scrollHeight, behavior });
    return;
  }
  container.scrollTop = container.scrollHeight;
}
