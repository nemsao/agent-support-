/**
 * backendService.ts — LOCAL-ONLY build.
 *
 * Cloud backend (deplaoapp.com) dependencies have been removed:
 * premium status, group scan, payment QR, shared-groups and affiliate APIs.
 * All features now run against local SQLite via IPC/DataAccessor.
 *
 * Only the shared group-category taxonomy is kept — BulkImportGroupsModal
 * uses it to classify locally imported groups.
 */

export interface SharedGroupCategory {
  id: number;
  name: string;
  icon: string;
  count?: number;
}

export const DEFAULT_CATEGORIES: SharedGroupCategory[] = [
  { id: 1, name: 'Kinh doanh', icon: '💼' },
  { id: 2, name: 'Bất động sản', icon: '🏠' },
  { id: 3, name: 'Giáo dục', icon: '📚' },
  { id: 4, name: 'Công nghệ', icon: '💻' },
  { id: 5, name: 'Sức khỏe', icon: '🏥' },
  { id: 6, name: 'Du lịch', icon: '✈️' },
  { id: 7, name: 'Ẩm thực', icon: '🍜' },
  { id: 8, name: 'Thời trang', icon: '👗' },
  { id: 9, name: 'Mỹ phẩm', icon: '💄' },
  { id: 10, name: 'Thực phẩm chức năng', icon: '💊' },
  { id: 11, name: 'Mẹ và bé', icon: '👶' },
  { id: 12, name: 'Nội thất', icon: '🛋️' },
  { id: 13, name: 'Ô tô - Xe máy', icon: '🚗' },
  { id: 14, name: 'Điện tử', icon: '📱' },
  { id: 15, name: 'Thể thao', icon: '⚽' },
  { id: 16, name: 'Thú cưng', icon: '🐾' },
  { id: 17, name: 'Nhà hàng - Khách sạn', icon: '🏨' },
  { id: 99, name: 'Khác', icon: '📁' },
];
