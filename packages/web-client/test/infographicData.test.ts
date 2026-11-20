import {describe, expect, it} from 'vitest';
import {lightChartKind, parseChartData} from '../src/InfographicData.js';

/** Plan P10 / S7: simple antv chart blocks drawn without @antv/infographic. */

const column = `infographic chart-column-simple
data
  title Memory-Bandbreite
  desc GB/s sustained
  xTitle System
  yTitle GB/s
  items
    - label Skynet (Xe-LPG)
      value 70
    - label DGX Spark
      value 273
      desc GB10
`;

describe('Infographic-Light', () => {
    it('only takes column, bar and line layouts', () => {
        expect(lightChartKind('chart-column-simple')).toBe('column');
        expect(lightChartKind('chart-bar-plain-text')).toBe('bar');
        expect(lightChartKind('chart-line')).toBe('line');
        expect(lightChartKind('chart-pie-donut-pill-badge')).toBeNull();
        expect(lightChartKind('relation-dagre-flow-lr-animated-compact-card')).toBeNull();
    });

    it('parses the antv data block', () => {
        expect(parseChartData(column)).toEqual({
            title: 'Memory-Bandbreite',
            desc: 'GB/s sustained',
            xTitle: 'System',
            yTitle: 'GB/s',
            items: [
                {label: 'Skynet (Xe-LPG)', value: 70},
                {label: 'DGX Spark', value: 273, desc: 'GB10'}
            ]
        });
    });

    it('accepts thousands separators, decimals and later top-level blocks', () => {
        const data = parseChartData('data\n  items\n    - label a\n      value 1,234.5\n    - label b\n      value 0.5\ntheme dark\n');
        expect(data?.items.map((i) => i.value)).toEqual([1234.5, 0.5]);
    });

    it('returns null so antv takes over: no data, missing or bad value, nested children', () => {
        expect(parseChartData('infographic chart-column\n')).toBeNull();
        expect(parseChartData('data\n  items\n    - label a\n')).toBeNull();
        expect(parseChartData('data\n  items\n    - label a\n      value many\n')).toBeNull();
        expect(parseChartData('data\n  items\n    - label a\n      value 1\n      children\n        - label b\n')).toBeNull();
        expect(parseChartData('data\n  title only\n')).toBeNull();
    });
});
