import { useEffect, useState } from 'react';
import { webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
import { MenuIcon } from '../icons';
import type { ShowcaseExample } from '../types';
import { MarkdownMessage } from './MarkdownMessage';

type Props = { onMenu: () => void; onTryInChat: (question: string) => void };

/**
 * «Примеры»: настоящие вопросы и настоящие ответы системы, снятые оператором
 * с боевого контура. Витрина возможностей: маршруты, рынок, интел,
 * производство, оценка лута. Кнопка «Спросить своё» уводит вопрос в чат.
 */
export function ExamplesScreen({ onMenu, onTryInChat }: Props) {
  const { t } = useI18n();
  const [examples, setExamples] = useState<ShowcaseExample[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    webApi.getExamples()
      .then((payload) => { if (alive) setExamples(payload.examples); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : t('requestFailed')); });
    return () => { alive = false; };
  }, [t]);

  const categories = examples
    ? [...new Set(examples.map((example) => example.category))]
    : [];

  return <section className="workspace-screen">
    <header className="workspace-header">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button>
      <div>
        <span className="workspace-kicker">{t('examplesKicker')}</span>
        <h1>{t('examplesTitle')}</h1>
        <p>{t('examplesLead')}</p>
      </div>
      <LocaleSwitch />
    </header>
    <div className="workspace-scroll">
      {error ? <div className="workspace-error" role="alert">{error}</div> : null}
      {examples === null && !error ? <div className="panel-loading">{t('loading')}…</div> : null}
      {examples !== null && examples.length === 0 ? <p className="conversation-list__empty">{t('examplesEmpty')}</p> : null}
      {categories.map((category) => <section className="examples-group" key={category}>
        <h2 className="examples-group__title">{category}</h2>
        {examples!.filter((example) => example.category === category).map((example) => {
          const open = openId === example.id;
          return <article className={`example-card${open ? ' example-card--open' : ''}`} key={example.id}>
            <button
              className="example-card__question"
              type="button"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : example.id)}
            >
              <span>{example.question}</span>
              <small>{open ? t('examplesHide') : t('examplesShow')}</small>
            </button>
            {open ? <div className="example-card__answer">
              <MarkdownMessage content={example.answer} />
              {example.tools.length ? <p className="example-card__tools">{t('examplesTools')}: {example.tools.join(' · ')}</p> : null}
              <button className="button" type="button" onClick={() => onTryInChat(example.question)}>{t('examplesTry')}</button>
            </div> : null}
          </article>;
        })}
      </section>)}
    </div>
  </section>;
}
