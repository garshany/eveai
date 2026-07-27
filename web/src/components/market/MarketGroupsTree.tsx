import { useEffect, useState, type ReactNode } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import { ChevronIcon } from '../../icons';
import type { MarketGroupTreeRow, MarketGroupTypeRow } from '../../types';

type GroupNodeState = {
  children: MarketGroupTreeRow[];
  types: MarketGroupTypeRow[];
  loading: boolean;
  loaded: boolean;
  error: boolean;
};

type Props = {
  onSelect: (typeId: number, name: string) => void;
  selectedTypeId?: number | null;
};

/**
 * Ленивое дерево маркет-групп: дети и типы группы подгружаются при первом
 * раскрытии (groups(parent) + groupTypes(id) параллельно). Сворачивание
 * сбрасывает поддерево — справочник SDE статичен, повторная загрузка дешёвая.
 */
export function MarketGroupsTree({ onSelect, selectedTypeId }: Props) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<MarketGroupTreeRow[] | null>(null);
  const [rootsError, setRootsError] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, GroupNodeState>>({});

  useEffect(() => {
    let cancelled = false;
    webApi.market.groups(null)
      .then((payload) => { if (!cancelled) setRoots(payload.groups); })
      .catch(() => { if (!cancelled) setRootsError(true); });
    return () => { cancelled = true; };
  }, []);

  const toggle = (group: MarketGroupTreeRow) => {
    const groupId = group.market_group_id;
    if (expanded[groupId]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[groupId];
        return next;
      });
      return;
    }
    setExpanded((current) => ({
      ...current,
      [groupId]: { children: [], types: [], loading: true, loaded: false, error: false },
    }));
    Promise.all([webApi.market.groups(groupId), webApi.market.groupTypes(groupId)])
      .then(([childrenPayload, typesPayload]) => {
        setExpanded((current) => (current[groupId]
          ? {
            ...current,
            [groupId]: {
              children: childrenPayload.groups,
              types: typesPayload.types,
              loading: false,
              loaded: true,
              error: false,
            },
          }
          : current));
      })
      .catch(() => {
        setExpanded((current) => (current[groupId]
          ? { ...current, [groupId]: { children: [], types: [], loading: false, loaded: false, error: true } }
          : current));
      });
  };

  const renderGroup = (group: MarketGroupTreeRow, depth: number): ReactNode => {
    const state = expanded[group.market_group_id];
    const indent = `calc(var(--space-3) + ${depth} * var(--space-5))`;
    return (
      <li key={group.market_group_id}>
        <button
          type="button"
          className={`market-groups__group${state ? ' market-groups__group--open' : ''}`}
          style={{ paddingLeft: indent }}
          aria-expanded={Boolean(state)}
          onClick={() => toggle(group)}
        >
          <ChevronIcon size={14} />
          <span>{group.name}</span>
        </button>
        {state ? (
          <div className="market-groups__children">
            {state.loading ? <p className="market-groups__note" style={{ paddingLeft: indent }}>{t('loading')}…</p> : null}
            {state.error ? <p className="market-groups__note market-groups__note--error" style={{ paddingLeft: indent }}>{t('requestFailed')}</p> : null}
            {state.loaded && state.children.length === 0 && state.types.length === 0
              ? <p className="market-groups__note" style={{ paddingLeft: indent }}>{t('marketGroupsEmpty')}</p>
              : null}
            {state.types.length > 0 ? (
              <ul className="market-groups__types">
                {state.types.map((type) => (
                  <li key={type.type_id}>
                    <button
                      type="button"
                      className={`market-groups__type${type.type_id === selectedTypeId ? ' market-groups__type--active' : ''}`}
                      style={{ paddingLeft: `calc(var(--space-3) + ${depth + 1} * var(--space-5))` }}
                      onClick={() => onSelect(type.type_id, type.name)}
                    >
                      {type.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.children.length > 0 ? (
              <ul className="market-groups__list">
                {state.children.map((child) => renderGroup(child, depth + 1))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <aside className="market-groups" aria-label={t('marketGroups')}>
      <h2 className="market-groups__title">{t('marketGroups')}</h2>
      {rootsError ? <p className="market-groups__note market-groups__note--error">{t('requestFailed')}</p> : null}
      {!roots && !rootsError ? <p className="market-groups__note">{t('loading')}…</p> : null}
      {roots ? <ul className="market-groups__list">{roots.map((group) => renderGroup(group, 0))}</ul> : null}
    </aside>
  );
}
