import { describe, expect, it } from 'vitest';
import { customerDraftKey } from '../features/customers/drafts';
import { validatePhoto } from '../features/customers/photos/photoValidation';

describe('React customer vertical slice contracts', () => {
  it('keeps customer drafts organization-scoped and rejects invalid photos before upload', () => {
    expect(customerDraftKey('org-a', 'customer-a')).toBe('org-a:customers:customer-a');
    expect(() => validatePhoto({ kind: 'path', name: 'bad.gif', contentType: 'image/gif', size: 1, path: 'C:/bad.gif' })).toThrow('JPEG');
  });
});
