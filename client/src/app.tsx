import { useEffect, useMemo, useRef, useState } from 'react';

type PageKind = 'landing' | 'dashboard';

interface RootProps {
  root: HTMLElement;
}

interface AppConfig {
  page: PageKind;
  botUsername: string;
  authUrl: string;
  botLink: string;
}

interface ProfileCharacter {
  characterId: number;
  characterName: string;
  portrait: string;
  isActive: boolean;
}

interface ProfileResponse {
  displayName: string;
  telegramUsername?: string;
  characters: ProfileCharacter[];
}

interface CommandSample {
  prompt: string;
  title: string;
  response: string;
  tools: string[];
}

interface GraphPrompt {
  query: string;
  result: string;
}

const commandSamples: CommandSample[] = [
  {
    prompt: 'Я лечу из Jita в Tama на Vexor. Оцени маршрут, где узкие места и как безопаснее пройти прямо сейчас.',
    title: 'Маршрут и риск',
    response:
      'Jita -> Tama: 4 прыжка. Главная пробка и почти весь риск сейчас в Tama: активный PvP, кемпы на входе и плохой заход для обычного Vexor.\n\nКоротко по решению: вручную, без автопилота, через gate cloak и быстрый выход в варп. Если цель просто добраться живым, лучше подождать тише окно или зайти на более легком корпусе.\n\nПрактический вывод: пройти можно, но безопасно в лоб на Vexor прямо сейчас — скорее нет.',
    tools: ['Маршрут', 'zKillboard', 'Риск'],
  },
  {
    prompt: 'Дай советы по сканерской части Gallente Election и скажи, как это фармить без глупых потерь.',
    title: 'Ивент и эксплор',
    response:
      'Относись к этим сайтам как к временным event data/relic site с высокой конкуренцией, а не как к спокойной эксплоре.\n\nЛучший режим: маленький быстрый корабль, тихий маршрут, постоянный d-scan и ротация кольцом по 8-15 системам. Если в локале охотники или появились combat probes, контейнер бросаешь и уходишь сразу.\n\nГлавная ошибка — залипать в одной системе и долго досканивать всё подряд. На этом ивенте выигрывает скорость цикла, а не жадность.',
    tools: ['Поиск', 'План', 'Маршрут'],
  },
  {
    prompt: 'Сделай Astero под скан этого ивента, привяжи маршрут к Aeschee и скажи, где потом крутить кольцо.',
    title: 'Фит и рабочий карман',
    response:
      'Astero под задачу: nano + inertial, MWD, Data/Relic Analyzer II, Scan Rangefinding, covops cloak и Sisters launcher.\n\nДо Aeschee агент дает два варианта: secure 9 прыжков и shortest 7. После прилета рабочее кольцо выглядит так: Aeschee -> Ladistier -> Old Man Star -> Villore -> Erme -> обратно в Aeschee.\n\nПрактика простая: прилетел, быстро прогнал сигнатуры, если система шумная — не залипаешь и сразу вращаешься дальше по кругу.',
    tools: ['Фит', 'SDE', 'Маршрут', 'zKillboard'],
  },
];

const capabilityLanes = [
  {
    label: 'Персонаж',
    description: 'клоны, импланты, очередь навыков, локация, корабль, кошелек, контракты',
  },
  {
    label: 'Вселенная',
    description: 'типы, догма, чертежи, торговые категории, регионы, станции, врата',
  },
  {
    label: 'Боевые данные',
    description: 'killboard паттерны, heatmap опасности, анализ фитов и контекст пилота',
  },
  {
    label: 'Логистика',
    description: 'маршруты, узкие проходы, обход кемпов, торговые хабы и закупочные списки',
  },
];

const workspaceLines = [
  '317+ ESI операций в одном агенте',
  'Локальный индекс данных игры для быстрых ответов',
  'Изоляция контекста по каждому пользователю и персонажу',
  'Telegram как основной интерфейс, web для входа и управления доступом',
];

const graphPrompts: GraphPrompt[] = [
  {
    query: 'Сделай Astero под ивент, подбери безопасный маршрут и скажи, где потом крутить системы.',
    result: 'Один ответ собирается из связей: Astero -> роль и слоты -> сигнатуры ивента -> текущая точка -> маршрут -> killboard активность -> рабочее кольцо систем.',
  },
  {
    query: 'Поставь маршрут в игру и сразу покажи, на каких системах мне нельзя тупить с грузом.',
    result: 'Здесь связываются узлы: старт -> цель -> варианты маршрута -> убито за час -> характер PvP -> решение, какой путь реально выставлять.',
  },
];

const heroShipImage = 'https://images.evetech.net/types/626/render?size=1024';

export function App({ root }: RootProps) {
  const config = useMemo<AppConfig>(() => readConfig(root), [root]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          }
        }
      },
      { threshold: 0.18 },
    );

    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    for (const element of elements) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, [config.page]);

  if (config.page === 'dashboard') {
    return <DashboardPage />;
  }

  return <LandingPage config={config} />;
}

function LandingPage({ config }: { config: AppConfig }) {
  return (
    <div className="min-h-screen bg-void text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[48rem] bg-[radial-gradient(circle_at_18%_18%,rgba(84,214,255,0.16),transparent_32%),radial-gradient(circle_at_82%_14%,rgba(255,145,77,0.14),transparent_28%),linear-gradient(180deg,rgba(6,10,20,0.1),rgba(6,10,20,0.94))]" />
        <div className="starfield absolute inset-0 opacity-50" />
      </div>

      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
        <div>
          <div className="font-display text-xl uppercase tracking-[0.32em] text-white/95">EVE AI</div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.28em] text-cyan-200/55">Для операций в New Eden</div>
        </div>
        <nav className="hidden items-center gap-8 font-mono text-xs uppercase tracking-[0.24em] text-white/55 lg:flex">
          <a href="#coverage" className="transition hover:text-white">Возможности</a>
          <a href="#knowledge-graph" className="transition hover:text-white">Граф</a>
          <a href="#scenarios" className="transition hover:text-white">Примеры</a>
          <a href="#access" className="transition hover:text-white">Вход</a>
        </nav>
      </header>

      <main>
        <section className="relative min-h-[calc(100svh-96px)] overflow-hidden px-6 pb-14 pt-2 lg:px-10 lg:pb-16 lg:pt-4">
          <div className="absolute inset-0">
            <div className="orbital absolute right-[-6rem] top-6 h-[40rem] w-[40rem] rounded-full border border-white/10 lg:right-[3%]" />
            <div className="orbital orbital-delay absolute right-[6%] top-18 h-[31rem] w-[31rem] rounded-full border border-cyan-300/16" />
            <div className="signal-beam absolute right-[24%] top-0 h-[34rem] w-px bg-gradient-to-b from-cyan-300/0 via-cyan-300/80 to-cyan-300/0 opacity-80" />
            <div className="absolute right-[8%] top-[7rem] h-[25rem] w-[25rem] rounded-full bg-[radial-gradient(circle,rgba(93,240,255,0.32),rgba(93,240,255,0.08)_30%,transparent_66%)] blur-3xl" />
            <div className="hero-grid absolute inset-0 opacity-45" />
            <div className="absolute inset-y-0 right-0 w-full bg-[linear-gradient(90deg,rgba(5,7,14,0.96)_0%,rgba(5,7,14,0.74)_38%,rgba(5,7,14,0.18)_100%)]" />
            <img
              src={heroShipImage}
              alt="EVE Online ship render"
              className="hero-ship absolute right-[-10%] top-[4.5rem] h-auto w-[52rem] max-w-none opacity-88 lg:right-[-2%] lg:w-[64rem]"
            />
            <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#05070e]" />
          </div>

          <div className="relative z-10 mx-auto grid max-w-7xl items-end gap-10 lg:grid-cols-[minmax(0,38rem)_1fr]">
            <div className="max-w-2xl pt-8 lg:pt-12">
              <div className="mb-6 inline-flex items-center gap-3 rounded-full border border-white/12 bg-black/20 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/65 backdrop-blur">
                <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.85)]" />
                AI агент для EVE Online
              </div>
              <p className="font-display text-[clamp(3.15rem,12vw,9rem)] uppercase leading-[0.88] tracking-[0.12em] text-white">
                EVE
              </p>
              <p className="font-display -mt-1 text-[clamp(2.6rem,10vw,7.2rem)] uppercase leading-[0.9] tracking-[0.24em] text-white/84 sm:-mt-2 sm:tracking-[0.28em]">
                Agent
              </p>
              <p className="mt-6 max-w-lg text-base leading-7 text-white/74 sm:mt-8 sm:text-xl sm:leading-8">
                Реальный помощник для New Eden: приватные данные персонажа, локальные данные игры, рынок, маршруты, фиты и внятные ответы
                по всей цепочке игры.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <a
                  href="/auth/eve/start"
                  className="inline-flex min-w-[15rem] items-center justify-between rounded-full border border-cyan-300/35 bg-cyan-300/12 px-6 py-4 font-mono text-xs uppercase tracking-[0.28em] text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-300/18"
                >
                  <span>Подключить EVE</span>
                  <span className="text-cyan-200/70">SSO</span>
                </a>
                <a
                  href="#access"
                  className="inline-flex items-center rounded-full border border-white/12 bg-white/4 px-6 py-4 font-mono text-xs uppercase tracking-[0.28em] text-white/68 transition hover:border-white/30 hover:text-white"
                >
                  Как войти
                </a>
              </div>
              <div className="mt-8 grid max-w-2xl gap-6 sm:mt-10 sm:grid-cols-3 sm:gap-8">
                <Metric value="317+" label="ESI операций" />
                <Metric value="1" label="один процесс" />
                <Metric value="100%" label="изоляция по пользователю" />
              </div>
            </div>

            <div className="relative z-10 hidden min-h-[36rem] lg:block">
              <div className="absolute bottom-10 right-0 max-w-[25rem] border-l border-white/10 pl-8" data-reveal>
                <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-white/42">Живой слой данных</div>
                <div className="mt-5 space-y-4">
                  <SignalRow label="Маркет" value="+14.8% спред" accent="text-cyan-200" />
                  <SignalRow label="Маршрут" value="2 safe, 1 hot" accent="text-orange-200" />
                  <SignalRow label="Персонаж" value="кошелек, имущество, навыки" accent="text-emerald-200" />
                  <SignalRow label="Ответ" value="поиск -> план -> вывод" accent="text-white" />
                </div>
              </div>
            </div>
          </div>
          <div className="relative z-10 mx-auto mt-16 max-w-7xl border-t border-white/8 pt-6">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/45">
              Рынок. PvP. Ассеты. Навыки. Маршруты. Инда. Корпорация.
            </div>
          </div>
        </section>

        <section id="coverage" className="relative z-10 px-6 py-24 lg:px-10">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="max-w-xl" data-reveal>
                <div className="eyebrow">Возможности</div>
                <h2 className="mt-4 font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                  Не просто чат, а слой управления всей игрой
                </h2>
                <p className="mt-6 text-base leading-8 text-white/68 sm:text-lg">
                  Внутри нет очередного “AI для гайдов”. Здесь агент знает состояние персонажа, умеет ходить по ESI,
                  быстро читает локальные данные игры и закрывает практические сценарии: что купить, куда лететь, чем драться,
                  что качать, где узкое место в твоем фите или логистике.
                </p>
              </div>

              <div className="space-y-5" data-reveal>
                {capabilityLanes.map((lane, index) => (
                  <div key={lane.label} className="group grid gap-3 border-b border-white/10 py-5 sm:grid-cols-[8rem_1fr]">
                    <div className="font-mono text-xs uppercase tracking-[0.3em] text-white/35">0{index + 1}</div>
                    <div>
                      <div className="font-display text-2xl uppercase tracking-[0.12em] text-white transition group-hover:text-cyan-100">
                        {lane.label}
                      </div>
                      <p className="mt-2 max-w-2xl text-base leading-7 text-white/62">{lane.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="knowledge-graph" className="relative z-10 border-y border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-6 py-18 sm:py-24 lg:px-10">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 sm:gap-14 lg:grid-cols-[1fr_1.12fr] lg:items-center">
              <div data-reveal>
                <div className="eyebrow">Граф знаний</div>
                <h2 className="mt-4 max-w-2xl font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                  Агент думает не списком, а связями
                </h2>
                <p className="mt-6 max-w-2xl text-base leading-8 text-white/68 sm:text-lg">
                  Корабль связан с бонусами, бонусы с навыками, навыки с твоим персонажем, персонаж с имуществом, имущество с рынком,
                  рынок с маршрутом, маршрут с риском. Поэтому ответ получается не “по одному API”, а по целой цепочке зависимостей.
                </p>
                <div className="mt-8 space-y-5 sm:mt-10 sm:space-y-6">
                  {graphPrompts.map((item, index) => (
                    <div key={item.query} className="grid gap-3 border-b border-white/10 pb-6 last:border-b-0 last:pb-0">
                      <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-cyan-200/72">Запрос 0{index + 1}</div>
                      <div className="border-l border-cyan-300/28 pl-4 font-mono text-sm leading-7 text-cyan-50/92 sm:pl-5">
                        {item.query}
                      </div>
                      <div className="max-w-2xl text-sm leading-7 text-white/70 sm:text-base sm:leading-8">{item.result}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative" data-reveal>
                <KnowledgeGraphVisual />
              </div>
            </div>
          </div>
        </section>

        <section id="scenarios" className="relative z-10 border-y border-white/8 bg-white/[0.03] px-6 py-24 lg:px-10">
          <div className="mx-auto max-w-7xl">
            <div className="mb-12 max-w-2xl" data-reveal>
                <div className="eyebrow">Реальные ответы</div>
                <h2 className="mt-4 font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                Что агент реально отвечает
                </h2>
              </div>
            <div className="grid gap-8">
              {commandSamples.map((sample) => (
                <article key={sample.title} className="grid gap-6 border-b border-white/10 pb-8 last:border-b-0 last:pb-0 lg:grid-cols-[minmax(0,20rem)_1fr]" data-reveal>
                  <div>
                    <div className="font-display text-2xl uppercase tracking-[0.14em] text-white">{sample.title}</div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {sample.tools.map((tool) => (
                        <span key={tool} className="rounded-full border border-white/12 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-white/48">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="border-l border-cyan-300/28 pl-5 font-mono text-sm leading-7 text-cyan-50/90">
                      {sample.prompt}
                    </div>
                    <div className="max-w-3xl whitespace-pre-line text-base leading-8 text-white/70">
                      {sample.response}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="access" className="relative z-10 px-6 py-24 lg:px-10">
          <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[1fr_0.9fr]">
            <div data-reveal>
              <div className="eyebrow">Вход</div>
              <h2 className="mt-4 font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                Быстрый доступ с нормальной изоляцией, а не с компромиссами
              </h2>
              <p className="mt-6 max-w-2xl text-base leading-8 text-white/68 sm:text-lg">
                Telegram дает вход и основной интерфейс. EVE SSO открывает приватные данные персонажа. Внутри всё держится отдельно по каждому пользователю,
                а web-слой нужен только там, где он действительно нужен: логин, привязка и контроль персонажей.
              </p>
              <div className="mt-10 max-w-xl">
                <TelegramLogin config={config} />
              </div>
            </div>
            <div className="space-y-4" data-reveal>
              <div className="space-y-4 border-l border-white/10 pl-6">
                <AccessItem step="01" title="Telegram" body="Быстрый вход через виджет или прямой переход в бота." />
                <AccessItem step="02" title="EVE SSO" body="Подключение одного или нескольких персонажей через официальный вход CCP." />
                <AccessItem step="03" title="Память" body="Треды, планы, состояние доступа и контекст остаются изолированными." />
                <AccessItem step="04" title="Ответ" body="Агент отвечает по реальным данным и разрешениям, а не по фантазии." />
              </div>
            </div>
          </div>
        </section>

        <section className="relative z-10 px-6 pb-24 lg:px-10">
          <div className="mx-auto max-w-7xl border-t border-white/8 pt-16">
            <div className="grid gap-12 lg:grid-cols-[1fr_0.9fr]">
              <div data-reveal>
                <div className="eyebrow">Основа</div>
                <h2 className="mt-4 font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                  Продуман под боевую эксплуатацию, а не под демо
                </h2>
              </div>
              <div className="space-y-4" data-reveal>
                {workspaceLines.map((line) => (
                  <div key={line} className="flex items-start gap-4 border-b border-white/10 pb-4">
                    <span className="mt-2 h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.85)]" />
                    <p className="text-base leading-7 text-white/72">{line}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="relative z-10 px-6 pb-24 lg:px-10">
          <div className="mx-auto max-w-7xl overflow-hidden border-y border-white/10 py-14">
            <div className="grid gap-10 lg:grid-cols-[1fr_24rem] lg:items-end">
              <div data-reveal>
                <div className="eyebrow">Старт</div>
                <h2 className="mt-4 max-w-3xl font-display text-4xl uppercase tracking-[0.14em] text-white sm:text-5xl">
                  Подключи Telegram, привяжи персонажа и получи сильного помощника по EVE
                </h2>
                <p className="mt-6 max-w-2xl text-base leading-8 text-white/68 sm:text-lg">
                  Один агент, один рабочий контекст, весь API-слой игры под рукой. Без лишнего интерфейса, без раздутой инфраструктуры, без пустых обещаний.
                </p>
              </div>
              <div className="flex flex-col gap-3" data-reveal>
                <a
                  href="/auth/eve/start"
                  className="inline-flex items-center justify-between rounded-full bg-white px-6 py-4 font-mono text-xs uppercase tracking-[0.28em] text-slate-900 transition hover:bg-cyan-100"
                >
                  <span>Подключить EVE</span>
                  <span>SSO</span>
                </a>
                {config.botLink ? (
                  <a
                    href={config.botLink}
                    className="inline-flex items-center justify-between rounded-full border border-white/12 px-6 py-4 font-mono text-xs uppercase tracking-[0.28em] text-white/70 transition hover:border-white/28 hover:text-white"
                  >
                    <span>Открыть Telegram</span>
                    <span>@{config.botUsername}</span>
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/8 px-6 py-8 text-sm text-white/40 lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <p>EVE Online and the EVE logo are registered trademarks of CCP hf.</p>
          <p>EVE Agent is a third-party tool and is not affiliated with CCP Games.</p>
        </div>
      </footer>
    </div>
  );
}

function DashboardPage() {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [busyCharacterId, setBusyCharacterId] = useState<number | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    void loadProfile();
  }, []);

  async function loadProfile() {
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/me');
      if (!response.ok) {
        window.location.href = '/';
        return;
      }

      const nextProfile = (await response.json()) as ProfileResponse;
      setProfile(nextProfile);
    } catch {
      setError('Не удалось загрузить профиль.');
    } finally {
      setIsLoading(false);
    }
  }

  async function post(path: string) {
    const response = await fetch(path, { method: 'POST' });
    if (response.status === 401) {
      window.location.href = '/';
      return false;
    }
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return true;
  }

  async function activateCharacter(characterId: number) {
    setBusyCharacterId(characterId);
    setError('');

    try {
      const ok = await post(`/api/characters/${encodeURIComponent(String(characterId))}/activate`);
      if (ok) {
        await loadProfile();
      }
    } catch {
      setError('Не удалось переключить персонажа.');
    } finally {
      setBusyCharacterId(null);
    }
  }

  async function unlinkCharacter(characterId: number) {
    const confirmed = window.confirm('Отвязать персонажа?');
    if (!confirmed) {
      return;
    }

    setBusyCharacterId(characterId);
    setError('');

    try {
      const ok = await post(`/api/characters/${encodeURIComponent(String(characterId))}/unlink`);
      if (ok) {
        await loadProfile();
      }
    } catch {
      setError('Не удалось отвязать персонажа.');
    } finally {
      setBusyCharacterId(null);
    }
  }

  async function logout() {
    setIsLoggingOut(true);

    try {
      await post('/auth/logout');
    } finally {
      window.location.href = '/';
    }
  }

  const telegramLine = profile
    ? `${profile.displayName}${profile.telegramUsername ? ` (@${profile.telegramUsername})` : ''}`
    : 'Сессия Telegram';

  return (
    <div className="min-h-screen bg-void text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[32rem] bg-[radial-gradient(circle_at_15%_15%,rgba(84,214,255,0.12),transparent_28%),radial-gradient(circle_at_85%_0%,rgba(255,145,77,0.12),transparent_26%),linear-gradient(180deg,rgba(5,7,14,0.9),rgba(5,7,14,1))]" />
      </div>

      <header className="relative z-10 border-b border-white/8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6 lg:flex-row lg:items-end lg:justify-between lg:px-10">
          <div>
            <div className="font-display text-3xl uppercase tracking-[0.22em] text-white">EVE Agent</div>
            <p className="mt-2 font-mono text-xs uppercase tracking-[0.22em] text-white/48">{telegramLine}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href="/auth/eve/start"
              className="inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-cyan-50 transition hover:border-cyan-200"
            >
              Добавить персонажа
            </a>
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              disabled={isLoggingOut}
              className="inline-flex items-center rounded-full border border-white/12 px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-white/70 transition hover:border-white/28 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoggingOut ? 'Выход...' : 'Выйти'}
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-6 py-10 lg:px-10">
        <section className="grid gap-10 lg:grid-cols-[minmax(0,19rem)_1fr]">
          <aside className="space-y-8">
            <div className="border-b border-white/10 pb-6">
              <div className="eyebrow">Сессия</div>
              <p className="mt-4 text-sm leading-7 text-white/68">
                Этот кабинет нужен только для доступа и переключения персонажей. Основной интерфейс агента остается в Telegram.
              </p>
            </div>
            <div className="space-y-4">
              <Metric value={profile?.characters.length ?? 0} label="привязанные персонажи" />
              <Metric value={profile?.characters.some((character) => character.isActive) ? '1' : '0'} label="активный персонаж" />
              <Metric value="Приватный" label="режим доступа ESI" />
            </div>
          </aside>

          <section>
            <div className="mb-6 flex items-end justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <div className="eyebrow">Персонажи</div>
                <h1 className="mt-3 font-display text-3xl uppercase tracking-[0.14em] text-white">Персонажи EVE</h1>
              </div>
            </div>

            {error ? <div className="mb-6 rounded-3xl border border-red-400/25 bg-red-500/10 px-5 py-4 text-sm text-red-100">{error}</div> : null}

            {isLoading ? (
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-10 text-white/55">Загрузка персонажей...</div>
            ) : null}

            {!isLoading && profile && profile.characters.length === 0 ? (
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-10 text-white/60">
                Пока нет привязанных персонажей. Подключи EVE SSO и добавь первого персонажа.
              </div>
            ) : null}

            {!isLoading && profile && profile.characters.length > 0 ? (
              <div className="space-y-4">
                {profile.characters.map((character) => {
                  const isBusy = busyCharacterId === character.characterId;

                  return (
                    <div
                      key={character.characterId}
                      className={`grid gap-5 rounded-[2rem] border px-5 py-5 backdrop-blur-sm sm:grid-cols-[5rem_1fr_auto] sm:items-center ${
                        character.isActive
                          ? 'border-cyan-300/30 bg-cyan-300/10'
                          : 'border-white/10 bg-white/[0.04]'
                      }`}
                    >
                      <img
                        src={character.portrait}
                        alt={`Portrait of ${character.characterName}`}
                        className="h-20 w-20 rounded-2xl border border-white/10 object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="font-display text-2xl uppercase tracking-[0.12em] text-white">{character.characterName}</h2>
                          {character.isActive ? (
                            <span className="rounded-full border border-cyan-300/28 bg-cyan-300/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.24em] text-cyan-100">
                              Активен
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 font-mono text-xs uppercase tracking-[0.22em] text-white/42">ID персонажа {character.characterId}</p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {!character.isActive ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              void activateCharacter(character.characterId);
                            }}
                            className="inline-flex items-center rounded-full border border-white/12 px-4 py-3 font-mono text-xs uppercase tracking-[0.24em] text-white/74 transition hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isBusy ? 'Переключение...' : 'Сделать активным'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            void unlinkCharacter(character.characterId);
                          }}
                          className="inline-flex items-center rounded-full border border-red-400/20 bg-red-500/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.24em] text-red-100 transition hover:border-red-300/40 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isBusy ? 'Обработка...' : 'Отвязать'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        </section>
      </main>
    </div>
  );
}

function TelegramLogin({ config }: { config: AppConfig }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!config.botUsername || !ref.current) {
      return;
    }

    const container = ref.current;
    container.replaceChildren();

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', config.botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '999');
    script.setAttribute('data-auth-url', config.authUrl);
    script.setAttribute('data-request-access', 'write');

    container.appendChild(script);

    return () => {
      container.replaceChildren();
    };
  }, [config.authUrl, config.botUsername]);

  if (!config.botUsername) {
    return (
      <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] px-5 py-4 text-sm text-white/55">
        Telegram login недоступен, пока не настроен `TELEGRAM_BOT_USERNAME`.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div ref={ref} className="telegram-widget-shell min-h-12" />
      {config.botLink ? (
        <a
          href={config.botLink}
          className="inline-flex items-center rounded-full border border-white/12 px-4 py-3 font-mono text-xs uppercase tracking-[0.24em] text-white/68 transition hover:border-white/26 hover:text-white"
        >
          Открыть @{config.botUsername} в Telegram
        </a>
      ) : null}
    </div>
  );
}

function AccessItem({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <div className="py-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/35">{step}</div>
      <div className="mt-3 font-display text-lg uppercase tracking-[0.12em] text-white">{title}</div>
      <p className="mt-2 text-sm leading-6 text-white/60">{body}</p>
    </div>
  );
}

function SignalRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/8 pb-3 text-sm last:border-b-0 last:pb-0">
      <span className="font-mono uppercase tracking-[0.22em] text-white/38">{label}</span>
      <span className={`font-mono uppercase tracking-[0.22em] ${accent}`}>{value}</span>
    </div>
  );
}

function KnowledgeGraphVisual() {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(84,214,255,0.14),rgba(4,7,15,0.26)_36%,rgba(4,7,15,0.94)_78%)]">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:72px_72px] opacity-18 sm:opacity-24" />
      <svg viewBox="0 0 860 700" className="relative block h-auto w-full">
        <defs>
          <radialGradient id="nodeGlow">
            <stop offset="0%" stopColor="rgba(112,240,255,0.55)" />
            <stop offset="100%" stopColor="rgba(112,240,255,0)" />
          </radialGradient>
        </defs>

        <g className="graph-lines">
          <line x1="430" y1="190" x2="206" y2="138" />
          <line x1="430" y1="190" x2="654" y2="142" />
          <line x1="430" y1="190" x2="232" y2="372" />
          <line x1="430" y1="190" x2="644" y2="364" />
          <line x1="430" y1="190" x2="430" y2="520" />
          <line x1="206" y1="138" x2="232" y2="372" />
          <line x1="654" y1="142" x2="644" y2="364" />
          <line x1="232" y1="372" x2="430" y2="520" />
          <line x1="644" y1="364" x2="430" y2="520" />
        </g>

        <g className="graph-dot graph-dot-a">
          <circle cx="430" cy="190" r="4" fill="#7cecff" />
        </g>
        <g className="graph-dot graph-dot-b">
          <circle cx="644" cy="364" r="4" fill="#7cecff" />
        </g>
        <g className="graph-dot graph-dot-c">
          <circle cx="232" cy="372" r="4" fill="#7cecff" />
        </g>

        <GraphNode x={430} y={190} title="Astero" subtitle="роль / fit" accent="cyan" large />
        <GraphNode x={206} y={138} title="Навыки" subtitle="scan / cloak / virus" accent="white" />
        <GraphNode x={654} y={142} title="Рынок" subtitle="цена / доступность" accent="white" />
        <GraphNode x={232} y={372} title="Маршрут" subtitle="Mattere / Aeschee" accent="white" />
        <GraphNode x={644} y={364} title="Риск" subtitle="киллы / camp / pvp" accent="white" />
        <GraphNode x={430} y={520} title="Пилот" subtitle="локация / план" accent="white" />
      </svg>
      </div>
      <div className="grid gap-4 border border-white/8 bg-[linear-gradient(180deg,rgba(6,10,18,0.22),rgba(6,10,18,0.56))] px-5 py-5 backdrop-blur-sm sm:grid-cols-3 sm:px-6 sm:py-6">
        <GraphMetric label="Узлы" value="корабли, навыки, регионы, ордера, киллы" />
        <GraphMetric label="Связи" value="требует, влияет, находится, продается, ведет через" />
        <GraphMetric label="Результат" value="один ответ поверх всех слоев игры" />
      </div>
    </div>
  );
}

function GraphNode({
  x,
  y,
  title,
  subtitle,
  accent,
  large = false,
}: {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  accent: 'cyan' | 'white';
  large?: boolean;
}) {
  const size = large ? 62 : 50;
  const stroke = accent === 'cyan' ? 'rgba(124,236,255,0.9)' : 'rgba(255,255,255,0.4)';
  const fill = accent === 'cyan' ? 'rgba(9,27,38,0.96)' : 'rgba(11,14,23,0.88)';
  const subtitleLines = subtitle.split(' / ');

  return (
    <g transform={`translate(${x}, ${y})`}>
      <circle r={size + 28} fill="url(#nodeGlow)" opacity={large ? 0.78 : 0.42} />
      <circle r={size} fill={fill} stroke={stroke} strokeWidth={large ? 2.4 : 1.4} />
      <text y={large ? -8 : -5} textAnchor="middle" className={`graph-title ${large ? 'graph-title-lg' : ''}`}>
        {title}
      </text>
      <text y={large ? 14 : 12} textAnchor="middle" className="graph-subtitle">
        {subtitleLines.map((line, index) => (
          <tspan key={`${title}-${line}`} x="0" dy={index === 0 ? 0 : 14}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function GraphMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-[0.26em] text-white/40">{label}</div>
      <p className="mt-2 text-sm leading-6 text-white/68">{value}</p>
    </div>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="border-b border-white/10 pb-4">
      <div className="font-display text-4xl uppercase tracking-[0.12em] text-white">{value}</div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.24em] text-white/45">{label}</div>
    </div>
  );
}

function readConfig(root: HTMLElement): AppConfig {
  const page = root.dataset.page === 'dashboard' ? 'dashboard' : 'landing';

  return {
    page,
    botUsername: root.dataset.botUsername ?? '',
    authUrl: root.dataset.authUrl ?? '',
    botLink: root.dataset.botLink ?? '',
  };
}
