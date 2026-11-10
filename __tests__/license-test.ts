import { isValidLicenseKeyFormat, normalizeLicenseKey } from '@/lib/license';

describe('license key format', () => {
  it('normalizes grouping, case and whitespace', () => {
    expect(normalizeLicenseKey(' null-abcd-efgh-jkmn ')).toBe('NULLABCDEFGHJKMN');
  });

  it('accepts keys the mint script can produce', () => {
    expect(isValidLicenseKeyFormat('NULL-ABCD-EFGH-JKMN')).toBe(true);
    expect(isValidLicenseKeyFormat('NULLABCDEFGHJKMN')).toBe(true);
  });

  it('rejects wrong prefixes, lengths and characters', () => {
    expect(isValidLicenseKeyFormat('ABCD-EFGH-JKMN-PQRS')).toBe(false);
    expect(isValidLicenseKeyFormat('NULL-ABCD')).toBe(false);
    expect(isValidLicenseKeyFormat('NULL-ABCD-EFGH-JKMN-O')).toBe(false);
  });
});
