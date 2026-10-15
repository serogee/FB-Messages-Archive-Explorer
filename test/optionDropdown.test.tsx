// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OptionDropdown } from '../src/components/Sidebar/OptionDropdown';

afterEach(cleanup);

const options = [
  { value: 'first', label: 'First' },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
  { value: 'last', label: 'Last' },
] as const;

function setup() {
  const onChange = vi.fn();
  const view = render(<OptionDropdown label="Choose option" value="first" options={options} onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: 'Choose option' });
  return { view, trigger, onChange };
}

it('navigates past unavailable options and restores focus after selecting or cancelling', () => {
  const { trigger, onChange } = setup();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'First' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Last' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'First' }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  fireEvent.click(document.activeElement!);
  expect(onChange).toHaveBeenCalledExactlyOnceWith('last');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Last' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('dismisses when focus or pointer leaves and never selects a disabled option', () => {
  const { trigger, onChange } = setup();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: 'Unavailable' }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();

  fireEvent.click(trigger);
  const outside = document.createElement('button');
  document.body.append(outside);
  act(() => outside.focus());
  expect(screen.queryByRole('listbox')).toBeNull();
  outside.remove();
});

it('closes and blocks interaction when the control becomes disabled', () => {
  const { view, trigger, onChange } = setup();
  fireEvent.click(trigger);
  view.rerender(<OptionDropdown label="Choose option" value="first" options={options} onChange={onChange} disabled />);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it('allows WebKit option clicks that blur without a related focus target', () => {
  const { trigger, onChange } = setup();
  fireEvent.click(trigger);
  fireEvent.blur(document.activeElement!, { relatedTarget: null });
  fireEvent.click(screen.getByRole('option', { name: 'Last' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('last');
  expect(screen.queryByRole('listbox')).toBeNull();
});
