import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MarketTypeInfo } from '../../types';
import { cachedMarketStatic } from './static-cache';
import { formatAttributeValue, formatIsk, formatQuantity } from './format';

type Props = {
  typeId: number;
  onSelect: (typeId: number, name: string) => void;
};

/**
 * Вкладка «О предмете»: описание, характеристики, навыки, dogma-атрибуты по
 * игровым категориям и мета-цепочка вариантов. Всё приходит одним ответом
 * /info и кэшируется в памяти вкладки (SDE статичен), включая ветку lang.
 */
export function TypeInfoPanel({ typeId, onSelect }: Props) {
  const { locale, t } = useI18n();
  const [info, setInfo] = useState<MarketTypeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  // bypassCache — только ретрай после ошибки (кэш ошибок не хранит, но так
  // явнее); generation защищает от гонок при смене товара/языка.
  const load = useCallback(async (bypassCache: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    const fetcher = () => webApi.market.info(typeId, locale);
    const pending = bypassCache ? fetcher() : cachedMarketStatic(`info:${typeId}:${locale}`, fetcher);
    try {
      const payload = await pending;
      if (current !== generation.current) return;
      setInfo(payload.info);
    } catch (reason) {
      if (current !== generation.current) return;
      setInfo(null);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [typeId, locale, t]);

  useEffect(() => { void load(false); }, [load]);

  if (loading) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) {
    return (
      <div className="workspace-error" role="alert">
        {error}
        <button type="button" onClick={() => void load(true)}>{t('retry')}</button>
      </div>
    );
  }
  if (!info) return null;

  const traits: Array<{ label: string; value: string }> = [];
  if (info.group_name) traits.push({ label: t('marketInfoGroup'), value: info.category_name ? `${info.category_name} / ${info.group_name}` : info.group_name });
  if (info.market_group_name) traits.push({ label: t('marketInfoMarketGroup'), value: info.market_group_name });
  if (info.meta_group_name) traits.push({ label: t('marketInfoMetaGroup'), value: info.meta_group_name });
  if (info.mass !== null && info.mass > 0) traits.push({ label: t('marketInfoMass'), value: `${formatQuantity(info.mass, locale)} ${t('marketInfoMassUnit')}` });
  if (info.volume !== null && info.volume > 0) traits.push({ label: t('marketInfoVolume'), value: `${formatQuantity(info.volume, locale)} m³` });
  if (info.capacity !== null && info.capacity > 0) traits.push({ label: t('marketInfoCapacity'), value: `${formatQuantity(info.capacity, locale)} m³` });
  if (info.base_price !== null && info.base_price > 0) traits.push({ label: t('marketInfoBasePrice'), value: `${formatIsk(info.base_price, locale, { compact: false })} ISK` });

  return (
    <section className="type-info" aria-label={t('marketTabAbout')}>
      {info.description ? <p className="type-info__description">{info.description}</p> : null}
      {traits.length > 0 ? (
        <dl className="type-info__traits">
          {traits.map((trait) => (
            <div className="type-info__trait" key={trait.label}>
              <dt>{trait.label}</dt>
              <dd>{trait.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {info.required_skills.length > 0 ? (
        <div className="type-info__block">
          <h3 className="type-info__heading">{t('marketInfoSkills')}</h3>
          <ul className="type-info__skills">
            {info.required_skills.map((skill) => (
              <li key={skill.type_id}>
                <span>{skill.name}</span>
                {skill.level !== null ? <small>{t('marketInfoSkillLevel').replace('{level}', String(skill.level))}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {info.attribute_groups.map((group) => (
        <div className="type-info__block" key={group.key}>
          <h3 className="type-info__heading">{t(`marketAttrGroup_${group.key}`)}</h3>
          <table className="type-info__attributes">
            <tbody>
              {group.attributes.map((attribute) => (
                <tr key={attribute.attribute_id}>
                  <td>{attribute.display_name ?? attribute.name ?? `#${attribute.attribute_id}`}</td>
                  <td className="type-info__attribute-value">{formatAttributeValue(attribute.value, attribute.unit, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {info.attribute_groups.length === 0 && info.required_skills.length === 0 && !info.description ? (
        <p className="type-info__empty">{t('marketInfoEmpty')}</p>
      ) : null}
      {info.variations.length > 1 ? (
        <div className="type-info__block">
          <h3 className="type-info__heading">{t('marketInfoVariations')}</h3>
          <ul className="type-info__variations">
            {info.variations.map((variation) => (
              <li key={variation.type_id}>
                <button
                  type="button"
                  className={`type-info__variation${variation.type_id === info.type_id ? ' type-info__variation--current' : ''}`}
                  disabled={variation.type_id === info.type_id}
                  onClick={() => onSelect(variation.type_id, variation.name)}
                >
                  <span>{variation.name}</span>
                  {variation.meta_group_name ? <small>{variation.meta_group_name}</small> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
