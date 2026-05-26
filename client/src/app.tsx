import { useEffect, useMemo, useState } from 'react';
import { exchangeHandoffToken, fetchProfile, postDashboardAction } from './api';
import { readConfig } from './config';
import type { AppConfig, ProfileResponse } from './types';

interface RootProps {
  root: HTMLElement;
}

interface CommandSample {
  prompt: string;
  title: string;
  response: string;
  tools: string[];
}

interface OperatingLane {
  label: string;
  title: string;
  text: string;
}

interface TacticalNote {
  value: string;
  label: string;
}

const commandSamples: CommandSample[] = [
  {
    prompt: 'Я лечу из Jita в Tama на Vexor. Оцени маршрут и риск.',
    title: 'Маршрут + Риск',
    response:
      'Jita → Tama: 4 прыжка. Tama — активный PvP, кемпы на входе. На Vexor в лоб прямо сейчас — скорее нет. Вручную через gate cloak или подождать тихое окно.',
    tools: ['plan_route', 'zkill', 'get_characters_character_id_location'],
  },
  {
    prompt: 'Сделай Astero под скан ивента, привяжи маршрут к Aeschee.',
    title: 'Фит + Маршрут',
    response:
      'Astero: nano + inertial, MWD, Analyzers II, covops cloak, Sisters launcher. До Aeschee: secure 9 / shortest 7 прыжков. Рабочее кольцо: Aeschee → Ladistier → Old Man Star → Villore → Erme → Aeschee.',
    tools: ['sde_sql', 'plan_route', 'zkill', 'batch_market_prices'],
  },
  {
    prompt: 'Покажи очередь навыков и скажи, что качать дальше.',
    title: 'Навыки',
    response:
      'В очереди 14 навыков на 23 дня. Cybernetics V через 4 дня откроет +5 импланты. После — Spaceship Command V для Astero бонусов.',
    tools: ['get_characters_character_id_skillqueue', 'get_characters_character_id_skills', 'sde_sql'],
  },
];

interface ApiCategory {
  name: string;
  count: number;
  desc: string;
  ops: string[];
}

const apiCategories: ApiCategory[] = [
  {
    name: 'Corporation',
    count: 22,
    desc: 'Полное управление корпорацией: активы, производство, финансы, участники, роли, структуры и цитадели.',
    ops: ['assets', 'blueprints', 'industry_jobs', 'wallet', 'members', 'member_tracking', 'roles', 'titles', 'medals', 'structures', 'starbases', 'customs_offices', 'facilities', 'contacts', 'standings', 'contracts', 'killmails', 'mining_extractions', 'mining_observers'],
  },
  {
    name: 'Universe',
    count: 14,
    desc: 'Данные о вселенной: звёзды, планеты, луны, станции, звёздные врата, системы, регионы и созвездия.',
    ops: ['systems', 'constellations', 'regions', 'stargates', 'stations', 'structures', 'stars', 'planets', 'moons', 'asteroid_belts', 'types', 'groups', 'categories', 'ids_names'],
  },
  {
    name: 'Character',
    count: 14,
    desc: 'Профиль персонажа: история, афилиации, портрет, корпоративная принадлежность и CSPA-настройки.',
    ops: ['public_info', 'portrait', 'affiliation', 'corporation_history', 'medals', 'titles', 'standings', 'agents_research', 'fatigue', 'notifications', 'cspa_charge'],
  },
  {
    name: 'Fleets',
    count: 14,
    desc: 'Управление флотом: участники, крылья и сквады, приглашения, перемещения по структуре.',
    ops: ['fleet_info', 'members', 'wings', 'squads', 'create_wing', 'create_squad', 'invite', 'kick', 'move_member', 'rename_squad', 'delete_wing'],
  },
  {
    name: 'Market',
    count: 11,
    desc: 'Рыночные данные: ордера по регионам и структурам, история цен, ценовые индексы, типы на рынке.',
    ops: ['region_orders', 'region_history', 'structure_orders', 'prices', 'type_ids', 'groups'],
  },
  {
    name: 'Contacts',
    count: 9,
    desc: 'Контакты и лейблы для персонажей, корпораций и альянсов.',
    ops: ['character_contacts', 'character_labels', 'corporation_contacts', 'corporation_labels', 'alliance_contacts', 'alliance_labels'],
  },
  {
    name: 'Contracts',
    count: 9,
    desc: 'Контракты персонажа, корпорации и публичные: ставки, предметы, детали.',
    ops: ['character_contracts', 'character_contract_bids', 'character_contract_items', 'corporation_contracts', 'public_contracts', 'public_bids', 'public_items'],
  },
  {
    name: 'Mail',
    count: 9,
    desc: 'Внутриигровая почта: чтение, отправка, лейблы, списки рассылки.',
    ops: ['mail_headers', 'mail_body', 'send_mail', 'mail_labels', 'update_labels', 'delete_mail', 'mailing_lists'],
  },
  {
    name: 'Faction Warfare',
    count: 8,
    desc: 'Фракционные войны: статистика, занятые системы, лидерборды, состояние войн.',
    ops: ['character_stats', 'corporation_stats', 'systems', 'leaderboards', 'wars', 'faction_stats'],
  },
  {
    name: 'Industry',
    count: 8,
    desc: 'Производство и исследования: задания, чертежи, индексы систем, публичные объекты.',
    ops: ['character_jobs', 'character_mining', 'corporation_jobs', 'corporation_mining', 'industry_systems', 'industry_facilities'],
  },
  {
    name: 'Assets',
    count: 6,
    desc: 'Инвентарь персонажа и корпорации: список, названия, расположение предметов.',
    ops: ['character_assets', 'character_asset_names', 'character_asset_locations', 'corporation_assets', 'corporation_asset_names', 'corporation_asset_locations'],
  },
  {
    name: 'Wallet',
    count: 6,
    desc: 'Финансы: баланс, журнал транзакций, детали операций — для персонажа и корпорации.',
    ops: ['balance', 'journal', 'transactions', 'corporation_wallets', 'corporation_journal', 'corporation_transactions'],
  },
  {
    name: 'Dogma',
    count: 5,
    desc: 'Система атрибутов и эффектов: характеристики модулей, кораблей и динамические предметы.',
    ops: ['attributes', 'attribute_info', 'effects', 'effect_info', 'dynamic_items'],
  },
  {
    name: 'UI',
    count: 5,
    desc: 'Управление интерфейсом клиента: автопилот, маркет, информация, контракты.',
    ops: ['autopilot_waypoint', 'open_market_details', 'open_information', 'open_contract', 'open_newmail'],
  },
  {
    name: 'Alliance',
    count: 4,
    desc: 'Информация об альянсах: профиль, иконки, список корпораций-членов.',
    ops: ['alliance_info', 'alliance_icons', 'alliance_corporations'],
  },
  {
    name: 'Calendar',
    count: 4,
    desc: 'Календарь событий: список, детали, ответы на приглашения.',
    ops: ['calendar_events', 'event_details', 'event_attendees', 'respond_to_event'],
  },
  {
    name: 'PI',
    count: 4,
    desc: 'Планетарное взаимодействие: колонии, схемы производства, таможенные посты.',
    ops: ['colonies', 'colony_layout', 'customs_offices', 'schematic_info'],
  },
  {
    name: 'Sovereignty',
    count: 3,
    desc: 'Суверенитет: карта влияния, структуры и активные кампании.',
    ops: ['sovereignty_map', 'sovereignty_structures', 'sovereignty_campaigns'],
  },
  {
    name: 'Skills',
    count: 3,
    desc: 'Навыки персонажа: текущие, очередь обучения, атрибуты и импланты.',
    ops: ['skills', 'skillqueue', 'attributes'],
  },
  {
    name: 'Killmails',
    count: 3,
    desc: 'Киллы: индекс убийств персонажа, детали киллмейла с фитом и участниками.',
    ops: ['character_killmails', 'corporation_killmails', 'killmail_details'],
  },
  {
    name: 'Location',
    count: 3,
    desc: 'Текущее положение: система, корабль, онлайн-статус персонажа.',
    ops: ['location', 'ship_type', 'online_status'],
  },
  {
    name: 'Wars',
    count: 3,
    desc: 'Военные декларации: список войн, детали, киллмейлы участников.',
    ops: ['war_list', 'war_details', 'war_killmails'],
  },
  {
    name: 'Fittings',
    count: 3,
    desc: 'Корабельные фиты: сохранённые сборки персонажа, создание и удаление.',
    ops: ['character_fittings', 'create_fitting', 'delete_fitting'],
  },
  {
    name: 'Clones',
    count: 2,
    desc: 'Клоны и импланты: активные клоны, расположение, установленные импланты.',
    ops: ['clones', 'implants'],
  },
  {
    name: 'Loyalty',
    count: 2,
    desc: 'Лоялти-поинты: очки верности у NPC-корпораций и доступные офферы.',
    ops: ['loyalty_points', 'loyalty_offers'],
  },
  {
    name: 'Incursions',
    count: 1,
    desc: 'Вторжения Sansha: активные инкурсии, системы и состояние.',
    ops: ['active_incursions'],
  },
  {
    name: 'Insurance',
    count: 1,
    desc: 'Страхование кораблей: стоимость и уровни выплат для всех типов.',
    ops: ['insurance_prices'],
  },
  {
    name: 'Routes',
    count: 1,
    desc: 'Маршрутизация: построение маршрута между системами через ESI.',
    ops: ['route'],
  },
  {
    name: 'Search',
    count: 1,
    desc: 'Поиск по вселенной: персонажи, корпорации, системы, станции, типы.',
    ops: ['search'],
  },
  {
    name: 'Status',
    count: 1,
    desc: 'Состояние кластера Tranquility: онлайн, количество игроков, версия.',
    ops: ['server_status'],
  },
];

const utilityTools = [
  { name: 'sde_sql', desc: 'SQL по статическим данным игры' },
  { name: 'plan_route', desc: 'Маршруты между системами' },
  { name: 'zkill', desc: 'zKillboard — киллы и PvP-активность' },
  { name: 'batch_market_prices', desc: 'Мультилот ценовой запрос' },
  { name: 'web_search', desc: 'Веб-поиск и EVE Wiki' },
  { name: 'get_eve_capabilities', desc: 'Проверка ESI-доступа персонажа' },
  { name: 'update_plan', desc: 'Трекинг плана действий' },
];

const operatingLanes: OperatingLane[] = [
  {
    label: '01',
    title: 'Пилот',
    text: 'Навыки, очередь, импланты, клоны, текущий корабль и живая локация персонажа.',
  },
  {
    label: '02',
    title: 'Пространство',
    text: 'Маршруты, choke points, региональная география, справка по SDE и реальные системы New Eden.',
  },
  {
    label: '03',
    title: 'Риск',
    text: 'zKillboard, PvP-активность, контекст по корпусу и быстрые рекомендации до выхода в warp.',
  },
];

const tacticalNotes: TacticalNote[] = [
  { value: '184', label: 'ESI-операций доступно' },
  { value: '30', label: 'категорий API' },
  { value: '7', label: 'утилит поверх ESI' },
];

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
      { threshold: 0.12 },
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

  if (config.page === 'handoff') {
    return <HandoffPage config={config} />;
  }

  return <LandingPage config={config} />;
}

function LandingPage({ config }: { config: AppConfig }) {
  return (
    <div className="min-h-screen text-white">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute inset-0 bg-void" />
        <div className="nebula absolute inset-0" />
        <div className="starfield absolute inset-0" />
        <div className="starfield-deep absolute inset-0" />
        <div className="star-map-grid absolute inset-0" />
        <div className="hero-haze absolute inset-0" />
        <div className="hero-ring hero-ring-a absolute right-[-12rem] top-[5rem] h-[32rem] w-[32rem] rounded-full" />
        <div className="hero-ring hero-ring-b absolute right-[10%] top-[12rem] h-[18rem] w-[18rem] rounded-full" />
        <div className="hero-sun absolute right-[8%] top-[10rem] h-[26rem] w-[26rem] rounded-full" />
      </div>

      <header className="relative z-10 px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 shadow-[0_0_40px_rgba(34,211,238,0.14)]">
            <span className="text-sm font-bold text-cyan-200">E</span>
          </div>
          <div>
            <div className="font-display text-sm uppercase tracking-[0.34em] text-white/92">EVE Agent</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/35">AI-агент для EVE Online</div>
          </div>
        </div>
        <nav className="hidden items-center gap-8 font-mono text-[11px] uppercase tracking-[0.24em] text-white/45 md:flex">
          <a href="#lanes" className="transition hover:text-white">Режимы</a>
          <a href="#examples" className="transition hover:text-white">Сценарии</a>
          <a href="#coverage" className="transition hover:text-white">Покрытие</a>
          <a href="#access" className="transition hover:text-white">Доступ</a>
        </nav>
        </div>
      </header>

      <main>
        <section className="relative z-10 overflow-hidden px-6 pb-20 pt-8">
          <div className="hero-gridline absolute inset-x-0 bottom-0 h-px" />
          <div className="mx-auto grid max-w-6xl items-end gap-10 lg:grid-cols-[minmax(0,32rem)_1fr]">
            <div className="max-w-xl pb-8 sm:pb-12">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/55 backdrop-blur-md">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
                оперативные данные пилота
              </div>

              <div className="mt-7">
                <div className="font-display text-[clamp(1.15rem,2vw,1.5rem)] uppercase tracking-[0.62em] text-cyan-200/72">
                  EVE Agent
                </div>
                <h1 className="mt-5 font-display text-[clamp(3.8rem,9vw,8.4rem)] uppercase leading-[0.86] tracking-[0.08em] text-white">
                  New Eden
                  <br />
                  in command
                </h1>
              </div>

              <p className="mt-7 max-w-md text-base leading-7 text-white/62 sm:text-lg sm:leading-8">
                AI-агент для EVE Online прямо в Telegram. Маршруты, фиты, рынок, навыки
                и риск-анализ — один чат вместо десяти вкладок.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="/auth/eve/start"
                  className="inline-flex items-center rounded-full border border-cyan-300/38 bg-cyan-300/12 px-6 py-3.5 font-mono text-xs uppercase tracking-[0.26em] text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-300/18"
                >
                  Подключить EVE SSO
                </a>
                {config.botLink ? (
                  <a
                    href={config.botLink}
                    className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.03] px-6 py-3.5 font-mono text-xs uppercase tracking-[0.26em] text-white/70 transition hover:border-white/26 hover:text-white"
                  >
                    Открыть @{config.botUsername}
                  </a>
                ) : null}
              </div>

              <div className="mt-12 grid gap-6 border-t border-white/10 pt-7 sm:grid-cols-3">
                {tacticalNotes.map((note) => (
                  <div key={note.label}>
                    <div className="font-display text-3xl uppercase tracking-[0.08em] text-white">{note.value}</div>
                    <div className="mt-1 max-w-[11rem] font-mono text-[10px] uppercase tracking-[0.22em] text-white/36">
                      {note.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="max-lg:hidden flex items-end">
              <div className="hero-panel w-full max-w-[30rem] overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/32 backdrop-blur-xl ml-auto">
                <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-cyan-200/62">Тактический обзор</div>
                    <div className="mt-1.5 font-display text-xl uppercase tracking-[0.12em] text-white">Jita → Tama</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/34">угроза</div>
                    <div className="mt-1.5 font-display text-2xl text-amber-300">72%</div>
                  </div>
                </div>

                <div className="px-6 pt-5">
                  <div className="tactical-map">
                    <span className="tactical-node node-a" />
                    <span className="tactical-node node-b" />
                    <span className="tactical-node node-c" />
                    <span className="tactical-node node-d" />
                    <span className="tactical-route" />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-px mt-5 border-t border-white/10 bg-white/[0.04]">
                  <div className="bg-[#05070e] px-4 py-3.5">
                    <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/34">рекомендация</div>
                    <div className="mt-1.5 font-display text-sm uppercase tracking-[0.08em] text-white">ручной варп</div>
                  </div>
                  <div className="bg-[#05070e] px-4 py-3.5">
                    <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/34">прыжков</div>
                    <div className="mt-1.5 font-display text-sm uppercase tracking-[0.08em] text-white">4</div>
                  </div>
                  <div className="bg-[#05070e] px-4 py-3.5">
                    <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/34">инструменты</div>
                    <div className="mt-1.5 font-mono text-[11px] text-cyan-200/60">route, zkill</div>
                  </div>
                </div>

                <div className="px-6 py-4">
                  <p className="text-sm leading-6 text-white/50">
                    Tama — активный PvP, кемпы на входе. Ждать тихое окно выгоднее, чем форсить проход.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="lanes" className="relative z-10 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="grid gap-12 lg:grid-cols-[0.95fr_1.05fr]">
              <div data-reveal>
                <div className="eyebrow">Режимы работы</div>
                <h2 className="mt-4 font-display text-3xl uppercase tracking-[0.12em] text-white sm:text-5xl">
                  Три направления.
                  <br />
                  Один агент.
                </h2>
                <p className="mt-5 max-w-md text-sm leading-7 text-white/48 sm:text-base">
                  Агент работает с живыми данными персонажа через ESI и собирает контекст
                  из нескольких источников в один ответ.
                </p>
              </div>

              <div className="space-y-8" data-reveal>
                {operatingLanes.map((lane) => (
                  <div key={lane.label} className="grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-[4rem_1fr]">
                    <div className="font-mono text-xs uppercase tracking-[0.32em] text-cyan-200/42">{lane.label}</div>
                    <div>
                      <h3 className="font-display text-2xl uppercase tracking-[0.12em] text-white">{lane.title}</h3>
                      <p className="mt-2 max-w-xl text-sm leading-7 text-white/52 sm:text-base">{lane.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="examples" className="relative z-10 border-y border-white/[0.06] bg-black/20 py-24 backdrop-blur-[2px]">
          <div className="mx-auto grid max-w-6xl gap-14 px-6 lg:grid-cols-[0.86fr_1.14fr]">
            <div className="lg:sticky lg:top-16 lg:self-start" data-reveal>
              <div className="eyebrow">Сценарии</div>
              <h2 className="mt-4 font-display text-3xl uppercase tracking-[0.12em] text-white sm:text-5xl">
                Ответы как
                <br />
                полётный бриф.
              </h2>
              <p className="mt-5 max-w-sm text-sm leading-7 text-white/48 sm:text-base">
                Агент не выдаёт сырые данные. Он собирает маршрут, рынок, фит и угрозы
                в готовое решение — как штурман рядом.
              </p>
            </div>

            <div className="space-y-6" data-reveal>
              {commandSamples.map((sample) => (
                <article key={sample.title} className="border-t border-white/10 pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-display text-2xl uppercase tracking-[0.12em] text-white">{sample.title}</h3>
                    <div className="flex flex-wrap gap-2">
                      {sample.tools.map((tool) => (
                        <code key={tool} className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200/60">
                          {tool}
                        </code>
                      ))}
                    </div>
                  </div>
                  <p className="mt-4 max-w-xl font-mono text-sm leading-7 text-white/70">{sample.prompt}</p>
                  <p className="mt-4 max-w-2xl text-sm leading-7 text-white/48 sm:text-base">{sample.response}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="coverage" className="relative z-10 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
              <div data-reveal>
                <div className="eyebrow">Покрытие</div>
                <h2 className="mt-4 font-display text-3xl uppercase tracking-[0.12em] text-white sm:text-5xl">
                  184 операции ESI.
                  <br />
                  Полное покрытие.
                </h2>
                <p className="mt-5 max-w-sm text-sm leading-7 text-white/48 sm:text-base">
                  Статические данные из локального SDE, живые — напрямую из ESI. Маршруты,
                  рынок и PvP-активность дополнены специализированными утилитами.
                </p>

                <div className="mt-10 border-t border-white/10 pt-6">
                  <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-white/34">Утилиты</div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {utilityTools.map((tool) => (
                      <div key={tool.name} className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-white/62">
                        <span className="font-mono text-cyan-200/72">{tool.name}</span>
                        <span className="ml-2 text-white/34">/</span>
                        <span className="ml-2">{tool.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2" data-reveal>
                {apiCategories.map((cat) => (
                  <ApiCategoryCard key={cat.name} category={cat} />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="access" className="relative z-10 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="cta-shell grid gap-12 overflow-hidden rounded-[2rem] border border-white/10 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1fr_0.9fr]">
              <div data-reveal>
                <div className="eyebrow">Доступ</div>
                <h2 className="mt-4 font-display text-3xl uppercase tracking-[0.12em] text-white sm:text-5xl">
                  Telegram + EVE SSO
                </h2>
                <p className="mt-5 max-w-xl text-sm leading-7 text-white/52 sm:text-base">
                  Вход через Telegram-бота, привязка персонажей через EVE SSO. Каждый пилот —
                  изолированный контекст и собственные разрешения.
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  {config.botLink ? (
                    <a
                      href={config.botLink}
                      className="inline-flex items-center rounded-full border border-cyan-300/38 bg-cyan-300/12 px-6 py-3.5 font-mono text-xs uppercase tracking-[0.26em] text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-300/18"
                    >
                      Открыть @{config.botUsername}
                    </a>
                  ) : null}
                  <a
                    href="/auth/eve/start"
                    className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.03] px-6 py-3.5 font-mono text-xs uppercase tracking-[0.26em] text-white/70 transition hover:border-white/24 hover:text-white"
                  >
                    Подключить EVE SSO
                  </a>
                </div>
              </div>

              <div className="space-y-3" data-reveal>
                <AccessStep num="01" title="Telegram" desc="Вход через бота — открой @Eveagentai_bot и напиши /start." />
                <AccessStep num="02" title="EVE SSO" desc="Привязка одного или нескольких персонажей через CCP OAuth." />
                <AccessStep num="03" title="Изоляция" desc="Контекст, треды, ESI-токены — всё отдельно для каждого пользователя." />
                <AccessStep num="04" title="Запрос" desc="Агент работает по реальным данным и разрешениям, не по угадыванию." />
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/[0.06] px-6 py-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 text-[11px] text-white/25 sm:flex-row sm:justify-between">
          <span>EVE Online and related marks are property of CCP hf.</span>
          <span>EVE Agent is a third-party tool, not affiliated with or endorsed by CCP Games.</span>
        </div>
      </footer>
    </div>
  );
}

function AccessStep({ num, title, desc }: { num: string; title: string; desc: string }) {
  return (
    <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-[3rem_1fr]">
      <span className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-200/42">{num}</span>
      <div>
        <div className="font-display text-base uppercase tracking-[0.12em] text-white">{title}</div>
        <p className="mt-1 text-sm leading-6 text-white/46">{desc}</p>
      </div>
    </div>
  );
}

function ApiCategoryCard({ category }: { category: ApiCategory }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className={`group cursor-pointer rounded-lg border transition-all duration-200 ${
        isOpen
          ? 'border-cyan-400/20 bg-cyan-400/[0.05]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/14 hover:bg-white/[0.04]'
      }`}
      onClick={() => setIsOpen(!isOpen)}
    >
      <div className="flex items-center justify-between px-4 py-3.5">
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">{category.name}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-cyan-200/72">{category.count}</span>
          <span className={`text-[10px] text-white/25 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
            &#9660;
          </span>
        </div>
      </div>
      {isOpen && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          <p className="text-[13px] leading-6 text-white/52">{category.desc}</p>
          <div className="mt-3 flex flex-wrap gap-1">
            {category.ops.map((op) => (
              <code key={op} className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-cyan-200/56">
                {op}
              </code>
            ))}
          </div>
        </div>
      )}
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
      const nextProfile = await fetchProfile();
      if (nextProfile === null) {
        window.location.href = '/';
        return;
      }

      setProfile(nextProfile);
    } catch {
      setError('Не удалось загрузить профиль.');
    } finally {
      setIsLoading(false);
    }
  }

  async function post(path: string) {
    const ok = await postDashboardAction(path);
    if (!ok) {
      window.location.href = '/';
    }
    return ok;
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
                Кабинет для управления доступом и персонажами. Основной интерфейс — в Telegram.
              </p>
            </div>
            <div className="space-y-4">
              <DashMetric value={profile?.characters.length ?? 0} label="привязанные персонажи" />
              <DashMetric value={profile?.characters.some((character) => character.isActive) ? '1' : '0'} label="активный персонаж" />
              <DashMetric value="Приватный" label="режим доступа ESI" />
            </div>
          </aside>

          <section>
            <div className="mb-6 flex items-end justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <div className="eyebrow">Персонажи</div>
                <h1 className="mt-3 font-display text-3xl uppercase tracking-[0.14em] text-white">Персонажи EVE</h1>
              </div>
            </div>

            {error ? <div className="mb-6 rounded-xl border border-red-400/25 bg-red-500/10 px-5 py-4 text-sm text-red-100">{error}</div> : null}

            {isLoading ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-6 py-10 text-white/55">Загрузка персонажей...</div>
            ) : null}

            {!isLoading && profile && profile.characters.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-6 py-10 text-white/60">
                Нет привязанных персонажей. Подключи EVE SSO.
              </div>
            ) : null}

            {!isLoading && profile && profile.characters.length > 0 ? (
              <div className="space-y-4">
                {profile.characters.map((character) => {
                  const isBusy = busyCharacterId === character.characterId;

                  return (
                    <div
                      key={character.characterId}
                      className={`grid gap-5 rounded-xl border px-5 py-5 backdrop-blur-sm sm:grid-cols-[5rem_1fr_auto] sm:items-center ${
                        character.isActive
                          ? 'border-cyan-300/30 bg-cyan-300/10'
                          : 'border-white/10 bg-white/[0.04]'
                      }`}
                    >
                      <img
                        src={character.portrait}
                        alt={`Portrait of ${character.characterName}`}
                        className="h-20 w-20 rounded-xl border border-white/10 object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="font-display text-2xl uppercase tracking-[0.12em] text-white">{character.characterName}</h2>
                          {character.isActive ? (
                            <span className="rounded-md border border-cyan-300/28 bg-cyan-300/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-100">
                              Активен
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 font-mono text-xs uppercase tracking-[0.22em] text-white/42">ID {character.characterId}</p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {!character.isActive ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              void activateCharacter(character.characterId);
                            }}
                            className="inline-flex items-center rounded-lg border border-white/12 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-white/74 transition hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isBusy ? 'Переключение...' : 'Активировать'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            void unlinkCharacter(character.characterId);
                          }}
                          className="inline-flex items-center rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-red-100 transition hover:border-red-300/40 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isBusy ? '...' : 'Отвязать'}
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

function HandoffPage({ config }: { config: AppConfig }) {
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function exchangeToken() {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (!token) {
        setError('Ссылка входа неполная или устарела. Открой панель заново из Telegram.');
        return;
      }

      window.history.replaceState(null, '', window.location.pathname);

      try {
        await exchangeHandoffToken(config.authUrl, token);

        if (!cancelled) {
          window.location.replace('/app');
        }
      } catch {
        if (!cancelled) {
          setError('Ссылка входа недействительна или уже истекла. Вернись в Telegram и открой панель ещё раз.');
        }
      }
    }

    void exchangeToken();
    return () => {
      cancelled = true;
    };
  }, [config.authUrl]);

  return (
    <div className="min-h-screen bg-void text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(84,214,255,0.08),transparent_24%),linear-gradient(180deg,rgba(5,7,14,0.88),rgba(5,7,14,1))]" />
      </div>
      <main className="relative z-10 mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
        <div className="w-full rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-8 backdrop-blur-xl">
          <div className="eyebrow">Telegram Handoff</div>
          <h1 className="mt-4 font-display text-3xl uppercase tracking-[0.14em] text-white">Завершаю вход</h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-white/58 sm:text-base">
            Создаю веб-сессию из одноразового токена Telegram. После успешного обмена откроется кабинет персонажей.
          </p>

          {error ? (
            <div className="mt-6 rounded-xl border border-red-400/25 bg-red-500/10 px-5 py-4 text-sm text-red-100">
              {error}
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-5 py-4 text-sm text-cyan-50">
              Проверяю токен и создаю защищённую сессию...
            </div>
          )}

          <div className="mt-8 flex flex-wrap gap-3">
            {config.botLink ? (
              <a
                href={config.botLink}
                className="inline-flex items-center rounded-full border border-white/12 px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-white/70 transition hover:border-white/28 hover:text-white"
              >
                Вернуться в @{config.botUsername}
              </a>
            ) : null}
            <a
              href="/"
              className="inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-cyan-50 transition hover:border-cyan-200"
            >
              На главную
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}


function DashMetric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="border-b border-white/10 pb-4">
      <div className="font-display text-4xl uppercase tracking-[0.12em] text-white">{value}</div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.24em] text-white/45">{label}</div>
    </div>
  );
}
