import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { parseAdvisorVehicleSearch } from '@/lib/advisor-data-validation';
import { AdvisorCatalogDataError, searchAdvisorVehicles } from '@/lib/advisor-catalog-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const access = await requireApiRole('employee');
    if (access.response) {
      access.response.headers.set('Cache-Control', headers['Cache-Control']);
      return access.response;
    }
    const params = new URL(request.url).searchParams;
    const parsed = parseAdvisorVehicleSearch(params);
    if (!parsed.success) {
      // Names only, bounded and escaped: never log URL values, headers or cookies.
      console.warn('[carwise.catalog.query]', {
        parameterNames: [...params.keys()].slice(0, 16).map(name =>
          /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) ? name : '[redacted-name]'),
        issues: parsed.issues
      });
      return NextResponse.json({ code: 'INVALID_VEHICLE_SEARCH_QUERY',
        error: 'פרמטרי חיפוש אינם תקינים', issues: parsed.issues }, { status: 400, headers });
    }
    const result = await searchAdvisorVehicles(parsed.data);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({
      code: error instanceof AdvisorCatalogDataError ? 'VEHICLE_CATALOG_INVALID_DATA' : 'VEHICLE_CATALOG_UNAVAILABLE',
      error: 'לא ניתן לטעון כרגע את קטלוג הרכבים. אפשר לנסות שוב מאוחר יותר.'
    }, { status: 503, headers });
  }
}
