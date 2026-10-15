// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PerformanceControls, PerformanceInformation } from '../src/components/Sidebar/PerformanceControls';
import { useSettings } from '../src/hooks/useSettings';
import { configurePerformance, defaultPerformancePreferences, normalizePerformancePreferences, performanceLimit, PERFORMANCE_FIELDS } from '../src/services/performanceSettings';

function Harness({ information = false }: { information?: boolean }) {
  const { settings, setSetting } = useSettings();
  return <>
    <PerformanceControls value={settings.performance} onChange={value => setSetting('performance', value)} />
    {information && <PerformanceInformation value={settings.performance} />}
  </>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); configurePerformance(defaultPerformancePreferences()); });

it('preserves existing defaults, switches saved mode values live, and restores them after reload', () => {
  const view = render(<Harness />);
  const archive = () => screen.getByRole('spinbutton', { name: 'Archive and chat reads' }) as HTMLInputElement;
  expect(archive().value).toBe('4');
  expect(archive().min).toBe('1'); expect(archive().max).toBe('16');
  expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
  for (const [key, field] of Object.entries(PERFORMANCE_FIELDS)) expect(performanceLimit(key as keyof typeof PERFORMANCE_FIELDS).get()).toBe(field.default);
  fireEvent.change(archive(), { target: { value: '6' } });
  expect(performanceLimit('archiveReads').get()).toBe(6);
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  fireEvent.click(screen.getByRole('option', { name: 'High' }));
  expect(performanceLimit('scans').get()).toBe(8);
  expect(performanceLimit('sizes').get()).toBe(2);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  expect(archive().value).toBe('4');
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('High');
  expect(performanceLimit('scans').get()).toBe(8);
  fireEvent.change(archive(), { target: { value: '3' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Chat image previews' }), { target: { value: '5' } });
  expect(performanceLimit('imagePreviews').get()).toBe(5);
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('High - Custom');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  expect(archive().value).toBe('6');
  expect(performanceLimit('imagePreviews').get()).toBe(4);
  expect(performanceLimit('scans').get()).toBe(8);
  view.unmount();
  render(<Harness />);
  expect(archive().value).toBe('6');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  expect(archive().value).toBe('3');
  expect((screen.getByRole('spinbutton', { name: 'Chat image previews' }) as HTMLInputElement).value).toBe('5');
  expect(performanceLimit('imagePreviews').get()).toBe(5);
});

it('resets individual rows and both saved modes, validates inputs, and retains the selected mode', () => {
  render(<Harness />);
  const archive = () => screen.getByRole('spinbutton', { name: 'Archive and chat reads' }) as HTMLInputElement;
  fireEvent.change(archive(), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  fireEvent.change(archive(), { target: { value: '999' } });
  expect(performanceLimit('archiveReads').get()).toBe(4);
  fireEvent.blur(archive());
  expect(archive().value).toBe('16');
  expect(performanceLimit('archiveReads').get()).toBe(16);
  fireEvent.click(screen.getByRole('button', { name: 'Reset archive and chat reads' }));
  expect(archive().value).toBe('4');
  fireEvent.change(archive(), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset all values' }));
  expect(archive().value).toBe('4');
  expect((screen.getByRole('checkbox', { name: 'Advanced performance' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  expect(archive().value).toBe('4');
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('Normal');
});

it('normalizes saved input and applies the default Normal pool limits', () => {
  const preferences = normalizePerformancePreferences({ advanced: true, archiveReads: -1, backgroundActivity: 'invalid', advancedLimits: { archiveReads: 1000, scans: -5, sizes: 2.6, imagePreviews: '5' } });
  expect(preferences).toMatchObject({ archiveReads: 1, backgroundActivity: 'normal', advancedLimits: { archiveReads: 16, scans: 1, sizes: 3, imagePreviews: 2 } });
  configurePerformance(preferences);
  configurePerformance(defaultPerformancePreferences());
  for (const [key, field] of Object.entries(PERFORMANCE_FIELDS)) expect(performanceLimit(key as keyof typeof PERFORMANCE_FIELDS).get()).toBe(field.default);
  const partial = normalizePerformancePreferences({ advanced: true, backgroundActivity: 'high', advancedLimits: { scans: 9 } });
  expect(partial.advancedLimits).toMatchObject({ imagePreviews: 4, galleryPreviews: 8, videoPreviews: 4, galleryVideoPreviews: 8, scans: 9, messengerScans: 2, sizes: 2, sizeDetails: 8 });
  const legacy = normalizePerformancePreferences({ advanced: true, advancedLimits: { attachmentReads: 6 } });
  expect(legacy.advancedLimits).toMatchObject({ attachmentReads: 6, galleryPreviews: 6 });
  const savedVideo = normalizePerformancePreferences({ advanced: true, backgroundActivity: 'high', advancedLimits: { videoPreviews: 5 } });
  expect(savedVideo.advancedLimits).toMatchObject({ videoPreviews: 5, galleryVideoPreviews: 8 });
  expect(normalizePerformancePreferences({ backgroundActivity: ['high'] }).backgroundActivity).toBe('normal');
});

it('applies arrow changes immediately and steps from empty or invalid drafts within the limits', () => {
  render(<Harness />);
  const archive = screen.getByRole('spinbutton', { name: 'Archive and chat reads' }) as HTMLInputElement;
  const increase = screen.getByRole('button', { name: 'Increase archive and chat reads' }) as HTMLButtonElement;
  const decrease = screen.getByRole('button', { name: 'Decrease archive and chat reads' }) as HTMLButtonElement;
  fireEvent.click(increase);
  expect(archive.value).toBe('5');
  expect(performanceLimit('archiveReads').get()).toBe(5);
  fireEvent.change(archive, { target: { value: '' } });
  fireEvent.click(decrease);
  expect(archive.value).toBe('4');
  expect(performanceLimit('archiveReads').get()).toBe(4);
  fireEvent.change(archive, { target: { value: '999' } });
  expect(increase.disabled).toBe(true);
  fireEvent.click(decrease);
  expect(archive.value).toBe('15');
  expect(performanceLimit('archiveReads').get()).toBe(15);
  fireEvent.click(increase);
  expect(increase.disabled).toBe(true);
  fireEvent.change(archive, { target: { value: '1' } });
  expect(decrease.disabled).toBe(true);
  fireEvent.click(increase);
  expect(archive.value).toBe('2');
  expect(performanceLimit('archiveReads').get()).toBe(2);
});

it('applies Ultra above High immediately, persists it, and resets it to Normal', () => {
  const view = render(<Harness />);
  const select = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
    fireEvent.click(screen.getByRole('option', { name }));
  };
  select('High');
  const categories = ['imagePreviews', 'galleryPreviews', 'videoPreviews', 'galleryVideoPreviews', 'scans', 'messengerScans', 'sizes', 'sizeDetails'] as const;
  expect(categories.map(category => performanceLimit(category).get())).toEqual([4, 8, 4, 8, 8, 2, 2, 8]);
  select('Ultra');
  expect(categories.map(category => performanceLimit(category).get())).toEqual([8, 16, 8, 16, 16, 4, 4, 16]);
  for (const category of ['archiveReads', 'attachmentReads', 'deletions', 'stickerDeletions'] as const) {
    expect(performanceLimit(category).get()).toBe(PERFORMANCE_FIELDS[category].default);
  }
  view.unmount();
  render(<Harness />);
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('Ultra');
  expect(categories.map(category => performanceLimit(category).get())).toEqual([8, 16, 8, 16, 16, 4, 4, 16]);
  fireEvent.click(screen.getByRole('button', { name: 'Reset background activity' }));
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('Normal');
  for (const [key, field] of Object.entries(PERFORMANCE_FIELDS)) expect(performanceLimit(key as keyof typeof PERFORMANCE_FIELDS).get()).toBe(field.default);
});

it('confirms resets briefly and restarts the confirmation after another click', () => {
  vi.useFakeTimers();
  render(<Harness />);
  const archive = screen.getByRole('spinbutton', { name: 'Archive and chat reads' }) as HTMLInputElement;
  fireEvent.change(archive, { target: { value: '8' } });
  const reset = screen.getByRole('button', { name: 'Reset archive and chat reads' });
  fireEvent.click(reset);
  expect(archive.value).toBe('4');
  expect(reset.dataset.confirmed).toBe('true');
  expect(screen.getByText('Reset to defaults.')).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  fireEvent.click(reset);
  act(() => vi.advanceTimersByTime(1000));
  expect(reset.dataset.confirmed).toBe('true');
  act(() => vi.advanceTimersByTime(600));
  expect(reset.dataset.confirmed).toBe('false');
  expect(screen.queryByText('Reset to defaults.')).toBeNull();
});

it('shows every active limit in the information stats through preset, mode, and reset changes', () => {
  render(<Harness information />);
  const stats = screen.getByRole('region', { name: 'Current concurrency settings' });
  expect(within(stats).getByText('JSON file at a time')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'General controls' })).getByText(/Current limit: 4 chat folders or JSON files at a time/)).toBeTruthy();
  const background = screen.getByRole('region', { name: 'Advanced background settings' });
  expect(within(background).queryByText('Archive and chat reads')).toBeNull();
  for (const [category, field] of Object.entries(PERFORMANCE_FIELDS)) {
    expect(within(screen.getByRole('region', { name: category === 'archiveReads' ? 'General controls' : 'Advanced background settings' })).getByText(field.label)).toBeTruthy();
  }
  const checkStats = () => {
    expect(stats.querySelectorAll('dd')).toHaveLength(Object.keys(PERFORMANCE_FIELDS).length);
    for (const [category, field] of Object.entries(PERFORMANCE_FIELDS)) {
      const row = within(stats).getByText(field.label).closest('div');
      expect(row?.querySelector('dd')?.textContent).toBe(String(performanceLimit(category as keyof typeof PERFORMANCE_FIELDS).get()));
    }
  };
  expect(within(stats).getByText('Basic · Normal')).toBeTruthy();
  checkStats();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Archive and chat reads' }), { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  fireEvent.click(screen.getByRole('option', { name: 'Ultra' }));
  expect(within(stats).getByText('Basic · Ultra')).toBeTruthy();
  expect(within(stats).getByText('JSON files at a time')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Advanced background settings' })).getByText(/Current limit: 16 image thumbnails at a time/)).toBeTruthy();
  checkStats();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Chat image previews' }), { target: { value: '7' } });
  expect(within(stats).getByText('Advanced · Ultra - Custom')).toBeTruthy();
  checkStats();
  fireEvent.click(screen.getByRole('button', { name: 'Reset all values' }));
  checkStats();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  expect(within(stats).getByText('Basic · Normal')).toBeTruthy();
  checkStats();
});

it('uses the preset as the advanced baseline, restores rows, and reapplies the same or a different preset', () => {
  render(<Harness />);
  const number = (label: string) => screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
  const select = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Low', 'Normal', 'High', 'Ultra']);
    fireEvent.click(screen.getByRole('option', { name, exact: true }));
  };
  fireEvent.click(screen.getByRole('checkbox', { name: 'Advanced performance' }));
  select('High');
  expect(screen.getAllByRole('spinbutton').map(input => (input as HTMLInputElement).value))
    .toEqual(['4', '4', '4', '4', '8', '8', '8', '2', '2', '8', '4', '1']);
  expect(screen.getAllByRole('spinbutton').every(input => input.dataset.comparison === 'default')).toBe(true);
  fireEvent.change(number('Shared-attachment scans'), { target: { value: '10' } });
  fireEvent.change(number('Size calculations'), { target: { value: '1' } });
  expect(number('Shared-attachment scans').dataset.comparison).toBe('above');
  expect(number('Size calculations').dataset.comparison).toBe('below');
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toContain('High - Custom');
  fireEvent.click(screen.getByRole('button', { name: 'Reset shared-attachment scans' }));
  expect(number('Shared-attachment scans').value).toBe('8');
  expect(performanceLimit('scans').get()).toBe(8);
  expect(number('Shared-attachment scans').dataset.comparison).toBe('default');
  fireEvent.click(screen.getByRole('button', { name: 'Reset size calculations' }));
  expect(screen.getByRole('button', { name: 'Background activity' }).textContent).toBe('High');
  fireEvent.change(number('Archive and chat reads'), { target: { value: '3' } });
  fireEvent.change(number('Attachment loading'), { target: { value: '6' } });
  fireEvent.change(number('Size calculations'), { target: { value: '1' } });
  select('High');
  expect(screen.getAllByRole('spinbutton').map(input => (input as HTMLInputElement).value))
    .toEqual(['4', '4', '4', '4', '8', '8', '8', '2', '2', '8', '4', '1']);
  expect(screen.getAllByRole('spinbutton').every(input => input.dataset.comparison === 'default')).toBe(true);
  expect(performanceLimit('archiveReads').get()).toBe(4);
  expect(performanceLimit('attachmentReads').get()).toBe(4);
  expect(performanceLimit('sizes').get()).toBe(2);
  fireEvent.change(number('Shared-attachment scans'), { target: { value: '' } });
  select('High');
  expect(number('Shared-attachment scans').value).toBe('8');
  select('Low');
  expect(screen.getAllByRole('spinbutton').map(input => (input as HTMLInputElement).value))
    .toEqual(['4', '4', '1', '1', '2', '2', '2', '1', '1', '2', '4', '1']);
  expect(performanceLimit('scans').get()).toBe(2);
  expect(performanceLimit('sizeDetails').get()).toBe(2);
});
