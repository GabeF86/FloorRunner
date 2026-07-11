/**
 * Component-library tests (node environment, zero new deps).
 *
 * Strategy per the ui-v1 plan: Modal's close behavior is factored into the
 * pure `modalCloseIntent` helper (tested directly), scroll locking into
 * `applyBodyScrollLock` (tested against a fake body), and render output is
 * asserted via react-dom/server renderToStaticMarkup — no @testing-library.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalCloseIntent, applyBodyScrollLock, Modal } from './Modal';
import { Badge } from './Badge';
import { Button } from './Button';
import { Table } from './Table';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { Card } from './Card';
import { PageHeader } from './PageHeader';
import { Spinner } from './Spinner';
import { Skeleton } from './Skeleton';

describe('modalCloseIntent', () => {
  it('closes on backdrop click when closeOnBackdrop is true', () => {
    expect(modalCloseIntent('backdrop', { closeOnBackdrop: true })).toBe(true);
  });

  it('ignores backdrop click when closeOnBackdrop is false', () => {
    expect(modalCloseIntent('backdrop', { closeOnBackdrop: false })).toBe(false);
  });

  it('always closes on Escape', () => {
    expect(modalCloseIntent('escape', { closeOnBackdrop: true })).toBe(true);
    expect(modalCloseIntent('escape', { closeOnBackdrop: false })).toBe(true);
  });

  it('never closes on clicks inside the content', () => {
    expect(modalCloseIntent('content', { closeOnBackdrop: true })).toBe(false);
    expect(modalCloseIntent('content', { closeOnBackdrop: false })).toBe(false);
  });
});

describe('applyBodyScrollLock', () => {
  it('locks overflow and restores the prior value', () => {
    const body = { style: { overflow: 'auto' } };
    const restore = applyBodyScrollLock(body);
    expect(body.style.overflow).toBe('hidden');
    restore();
    expect(body.style.overflow).toBe('auto');
  });

  it('restores an initially empty overflow', () => {
    const body = { style: { overflow: '' } };
    const restore = applyBodyScrollLock(body);
    expect(body.style.overflow).toBe('hidden');
    restore();
    expect(body.style.overflow).toBe('');
  });
});

describe('Modal (SSR safety)', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <Modal open={false} onClose={() => {}} title="T">body</Modal>
    );
    expect(html).toBe('');
  });

  it('renders nothing (and does not crash) without a document, since it portals to document.body', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="T">body</Modal>
    );
    expect(html).toBe('');
  });
});

describe('Badge', () => {
  it('renders tone background from the status vars', () => {
    const html = renderToStaticMarkup(<Badge tone="warn">Pending</Badge>);
    expect(html).toContain('Pending');
    expect(html).toContain('var(--warn-bg)');
    expect(html).toContain('var(--warn)');
  });

  it('neutral tone uses the surface tint, not a status color', () => {
    const html = renderToStaticMarkup(<Badge tone="neutral">Draft</Badge>);
    expect(html).toContain('var(--tint-surface)');
    expect(html).not.toContain('var(--warn');
  });
});

describe('Button', () => {
  it('primary variant fills with the brand accent', () => {
    const html = renderToStaticMarkup(<Button>Save changes</Button>);
    expect(html).toContain('Save changes');
    expect(html).toContain('var(--blue)');
    expect(html).toContain('fr-focus');
  });

  it('danger variant uses the danger status vars', () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete</Button>);
    expect(html).toContain('var(--danger)');
  });

  it('passes through disabled', () => {
    const html = renderToStaticMarkup(<Button disabled>Save</Button>);
    expect(html).toContain('disabled');
  });
});

describe('Table', () => {
  const headers = ['Name', 'Site', 'Status'];

  it('renders 3 skeleton rows while rows are undefined', () => {
    const html = renderToStaticMarkup(<Table headers={headers} rows={undefined} />);
    const skeletons = html.match(/fr-skeleton/g) ?? [];
    expect(skeletons.length).toBe(3 * headers.length);
    expect(html).toContain('<table');
  });

  it('renders the empty node when rows is []', () => {
    const html = renderToStaticMarkup(
      <Table headers={headers} rows={[]} empty={<span>No providers yet</span>} />
    );
    expect(html).toContain('No providers yet');
  });

  it('falls back to a default EmptyState when rows is [] and no empty node given', () => {
    const html = renderToStaticMarkup(<Table headers={headers} rows={[]} />);
    expect(html).toContain('Nothing here yet');
  });

  it('renders headers and cells for real rows', () => {
    const html = renderToStaticMarkup(
      <Table headers={headers} rows={[['Dr. Chen', 'Main OR', 'Active']]} />
    );
    expect(html).toContain('Name');
    expect(html).toContain('Dr. Chen');
    expect(html).toContain('Main OR');
  });
});

describe('Banner', () => {
  it('maps success to the ok status vars', () => {
    const html = renderToStaticMarkup(<Banner tone="success">Published</Banner>);
    expect(html).toContain('var(--ok');
  });

  it('maps error to the danger status vars and shows a dismiss control when dismissible', () => {
    const html = renderToStaticMarkup(
      <Banner tone="error" onDismiss={() => {}}>Validation failed</Banner>
    );
    expect(html).toContain('var(--danger');
    expect(html).toContain('Dismiss');
  });
});

describe('EmptyState / Card / PageHeader / Spinner / Skeleton', () => {
  it('EmptyState renders title, hint, and action', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No schedules yet" hint="Create one to get started." action={<button>New schedule</button>} />
    );
    expect(html).toContain('No schedules yet');
    expect(html).toContain('Create one to get started.');
    expect(html).toContain('New schedule');
  });

  it('Card renders title, children, and footer on the surface treatment', () => {
    const html = renderToStaticMarkup(
      <Card title="Coverage" footer={<span>Updated today</span>}>Body</Card>
    );
    expect(html).toContain('Coverage');
    expect(html).toContain('Body');
    expect(html).toContain('Updated today');
    expect(html).toContain('var(--bg-surface)');
  });

  it('PageHeader renders title, subtitle, and actions', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Providers" subtitle="85 active" actions={<button>Add</button>} />
    );
    expect(html).toContain('Providers');
    expect(html).toContain('85 active');
    expect(html).toContain('Add');
  });

  it('Spinner respects the size prop', () => {
    const html = renderToStaticMarkup(<Spinner size={24} />);
    expect(html).toContain('24');
  });

  it('Skeleton carries the shimmer class and default height', () => {
    const html = renderToStaticMarkup(<Skeleton width="60%" />);
    expect(html).toContain('fr-skeleton');
    expect(html).toContain('14');
  });
});
