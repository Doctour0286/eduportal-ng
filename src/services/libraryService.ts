import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BookTitle {
  id: string;
  school_id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  subject_id: string | null;
  subject_name: string | null;
  cover_url: string | null;
  created_at: string;
  // computed from book_copies
  total_copies: number;
  available_copies: number;
}

export interface BookCopy {
  id: string;
  school_id: string;
  book_title_id: string;
  barcode: string | null;
  condition: string | null;
  status: 'available' | 'borrowed' | 'lost' | 'retired';
  created_at: string;
}

export interface BorrowRecord {
  id: string;
  school_id: string;
  book_copy_id: string;
  book_title: string;
  barcode: string | null;
  student_id: string | null;
  student_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  borrowed_at: string;
  due_date: string;
  returned_at: string | null;
  issued_by: string;
  issued_by_name: string | null;
  created_at: string;
  is_overdue: boolean;
  fine?: LibraryFine | null;
}

export interface LibraryFine {
  id: string;
  school_id: string;
  borrow_record_id: string;
  amount: number;
  status: 'unpaid' | 'paid' | 'waived';
  created_at: string;
}

export interface DigitalResource {
  id: string;
  title: string;
  description: string | null;
  resource_type: 'pdf' | 'docx' | 'image' | 'embedded_link' | 'video';
  file_url: string | null;
  embed_url: string | null;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface SubjectTag {
  id: string;
  name: string;
}

export interface BookTitleInput {
  title: string;
  author: string;
  isbn: string;
  subject_id: string | null;
  cover_url: string | null;
}

export interface BookCopyInput {
  book_title_id: string;
  barcode: string;
  condition: string;
}

export interface BorrowInput {
  book_copy_id: string;
  borrower_type: 'student' | 'staff';
  borrower_id: string;
  due_date: string;
  issued_by_staff_id: string;
}

export interface FineInput {
  borrow_record_id: string;
  amount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


function isOverdue(dueDate: string, returnedAt: string | null): boolean {
  if (returnedAt) return false;
  return new Date(dueDate) < new Date();
}

function friendlyError(err: unknown, context: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('unique') && msg.includes('barcode'))
    return 'That barcode is already registered for another copy in this school.';
  if (msg.includes('not-null') || msg.includes('null value'))
    return `${context}: a required field is missing.`;
  if (msg.includes('foreign key') || msg.includes('violates'))
    return `${context}: linked record not found — please refresh and try again.`;
  return `${context}: ${msg}`;
}

// ─── Book Titles ──────────────────────────────────────────────────────────────

export async function loadBookTitles(schoolId: string): Promise<BookTitle[]> {
  const { data, error } = await supabase
    .from('book_titles')
    .select(`
      id, school_id, title, author, isbn, subject_id, cover_url, created_at,
      subjects(name),
      book_copies(id, status)
    `)
    .eq('school_id', schoolId)
    .order('title');

  if (error) throw new Error(friendlyError(error, 'Failed to load books'));

  return (data ?? []).map((r) => {
    const copies = (r.book_copies ?? []) as { id: string; status: string }[];
    return {
      id: r.id,
      school_id: r.school_id,
      title: r.title,
      author: r.author,
      isbn: r.isbn,
      subject_id: r.subject_id,
      subject_name: r.subjects ? (r.subjects as unknown as { name: string }[])[0]?.name ?? null : null,
      cover_url: r.cover_url,
      created_at: r.created_at,
      total_copies: copies.length,
      available_copies: copies.filter((c) => c.status === 'available').length,
    };
  });
}

export async function createBookTitle(
  schoolId: string,
  input: BookTitleInput
): Promise<BookTitle> {
  const { data, error } = await supabase
    .from('book_titles')
    .insert({
      school_id: schoolId,
      title: input.title.trim(),
      author: input.author.trim() || null,
      isbn: input.isbn.trim() || null,
      subject_id: input.subject_id || null,
      cover_url: input.cover_url || null,
    })
    .select(`id, school_id, title, author, isbn, subject_id, cover_url, created_at, subjects(name)`)
    .single();

  if (error) throw new Error(friendlyError(error, 'Failed to add book'));

  return {
    ...data,
    subject_name: data.subjects ? (data.subjects as unknown as { name: string }[])[0]?.name ?? null : null,
    total_copies: 0,
    available_copies: 0,
  };
}

export async function updateBookTitle(
  id: string,
  input: BookTitleInput
): Promise<void> {
  const { error } = await supabase
    .from('book_titles')
    .update({
      title: input.title.trim(),
      author: input.author.trim() || null,
      isbn: input.isbn.trim() || null,
      subject_id: input.subject_id || null,
      cover_url: input.cover_url || null,
    })
    .eq('id', id);

  if (error) throw new Error(friendlyError(error, 'Failed to update book'));
}

// ─── Book Copies ──────────────────────────────────────────────────────────────

export async function loadCopiesForTitle(titleId: string): Promise<BookCopy[]> {
  const { data, error } = await supabase
    .from('book_copies')
    .select('id, school_id, book_title_id, barcode, condition, status, created_at')
    .eq('book_title_id', titleId)
    .order('created_at');

  if (error) throw new Error(friendlyError(error, 'Failed to load copies'));
  return (data ?? []) as BookCopy[];
}

export async function addBookCopy(
  schoolId: string,
  input: BookCopyInput
): Promise<BookCopy> {
  const { data, error } = await supabase
    .from('book_copies')
    .insert({
      school_id: schoolId,
      book_title_id: input.book_title_id,
      barcode: input.barcode.trim() || null,
      condition: input.condition || 'good',
      status: 'available',
    })
    .select('id, school_id, book_title_id, barcode, condition, status, created_at')
    .single();

  if (error) throw new Error(friendlyError(error, 'Failed to add copy'));
  return data as BookCopy;
}

export async function updateCopyStatus(
  copyId: string,
  status: BookCopy['status'],
  condition?: string
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (condition !== undefined) patch.condition = condition;

  const { error } = await supabase
    .from('book_copies')
    .update(patch)
    .eq('id', copyId);

  if (error) throw new Error(friendlyError(error, 'Failed to update copy'));
}

// ─── Borrow Records ───────────────────────────────────────────────────────────

export async function loadActiveBorrows(schoolId: string): Promise<BorrowRecord[]> {
  const { data, error } = await supabase
    .from('borrow_records')
    .select(`
      id, school_id, book_copy_id, student_id, staff_id,
      borrowed_at, due_date, returned_at, issued_by, created_at,
      book_copies(barcode, book_titles(title)),
      students(full_name),
      staff!borrow_records_staff_id_fkey(full_name),
      issuer:staff!borrow_records_issued_by_fkey(full_name),
      library_fines(id, amount, status, created_at)
    `)
    .eq('school_id', schoolId)
    .is('returned_at', null)
    .order('due_date');

  if (error) throw new Error(friendlyError(error, 'Failed to load active borrows'));

  return mapBorrowRows(data ?? []);
}

export async function loadBorrowHistory(
  schoolId: string,
  limit = 50
): Promise<BorrowRecord[]> {
  const { data, error } = await supabase
    .from('borrow_records')
    .select(`
      id, school_id, book_copy_id, student_id, staff_id,
      borrowed_at, due_date, returned_at, issued_by, created_at,
      book_copies(barcode, book_titles(title)),
      students(full_name),
      staff!borrow_records_staff_id_fkey(full_name),
      issuer:staff!borrow_records_issued_by_fkey(full_name),
      library_fines(id, amount, status, created_at)
    `)
    .eq('school_id', schoolId)
    .not('returned_at', 'is', null)
    .order('returned_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(friendlyError(error, 'Failed to load history'));

  return mapBorrowRows(data ?? []);
}

export async function loadOverdueBorrows(schoolId: string): Promise<BorrowRecord[]> {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('borrow_records')
    .select(`
      id, school_id, book_copy_id, student_id, staff_id,
      borrowed_at, due_date, returned_at, issued_by, created_at,
      book_copies(barcode, book_titles(title)),
      students(full_name),
      staff!borrow_records_staff_id_fkey(full_name),
      issuer:staff!borrow_records_issued_by_fkey(full_name),
      library_fines(id, amount, status, created_at)
    `)
    .eq('school_id', schoolId)
    .is('returned_at', null)
    .lt('due_date', today)
    .order('due_date');

  if (error) throw new Error(friendlyError(error, 'Failed to load overdue borrows'));

  return mapBorrowRows(data ?? []);
}

function mapBorrowRows(rows: unknown[]): BorrowRecord[] {
  return (rows as Record<string, unknown>[]).map((r) => {
    const copy = r.book_copies as Record<string, unknown> | null;
    const bookTitle = copy?.book_titles as Record<string, unknown> | null;
    const student = r.students as { full_name: string } | null;
    const staffBorrower = r.staff as { full_name: string } | null;
    const issuer = r.issuer as { full_name: string } | null;
    const fines = (r.library_fines as Record<string, unknown>[] | null) ?? [];

    return {
      id: r.id as string,
      school_id: r.school_id as string,
      book_copy_id: r.book_copy_id as string,
      book_title: bookTitle?.title as string ?? 'Unknown title',
      barcode: copy?.barcode as string | null,
      student_id: r.student_id as string | null,
      student_name: student?.full_name ?? null,
      staff_id: r.staff_id as string | null,
      staff_name: staffBorrower?.full_name ?? null,
      borrowed_at: r.borrowed_at as string,
      due_date: r.due_date as string,
      returned_at: r.returned_at as string | null,
      issued_by: r.issued_by as string,
      issued_by_name: issuer?.full_name ?? null,
      created_at: r.created_at as string,
      is_overdue: isOverdue(r.due_date as string, r.returned_at as string | null),
      fine: fines.length > 0
        ? {
            id: fines[0].id as string,
            school_id: fines[0].school_id as string,
            borrow_record_id: fines[0].borrow_record_id as string,
            amount: fines[0].amount as number,
            status: fines[0].status as 'unpaid' | 'paid' | 'waived',
            created_at: fines[0].created_at as string,
          }
        : null,
    };
  });
}

export async function checkoutBook(
  schoolId: string,
  input: BorrowInput
): Promise<BorrowRecord> {
  // 1. Verify copy is available
  const { data: copy, error: copyErr } = await supabase
    .from('book_copies')
    .select('id, status, barcode, book_title_id')
    .eq('id', input.book_copy_id)
    .eq('school_id', schoolId)
    .single();

  if (copyErr || !copy)
    throw new Error('Copy not found — please scan or search again.');
  if (copy.status !== 'available')
    throw new Error(
      `This copy is currently ${copy.status} and cannot be checked out.`
    );

  // 2. Create borrow record
  const borrowPayload: Record<string, unknown> = {
    school_id: schoolId,
    book_copy_id: input.book_copy_id,
    due_date: input.due_date,
    issued_by: input.issued_by_staff_id,
  };
  if (input.borrower_type === 'student') {
    borrowPayload.student_id = input.borrower_id;
  } else {
    borrowPayload.staff_id = input.borrower_id;
  }

  const { data: record, error: recordErr } = await supabase
    .from('borrow_records')
    .insert(borrowPayload)
    .select('id, school_id, book_copy_id, student_id, staff_id, borrowed_at, due_date, returned_at, issued_by, created_at')
    .single();

  if (recordErr) throw new Error(friendlyError(recordErr, 'Failed to checkout book'));

  // 3. Mark copy as borrowed
  const { error: updateErr } = await supabase
    .from('book_copies')
    .update({ status: 'borrowed' })
    .eq('id', input.book_copy_id);

  if (updateErr) throw new Error(friendlyError(updateErr, 'Checkout recorded but copy status could not be updated — please update manually.'));

  return {
    ...(record as BorrowRecord),
    book_title: '',
    barcode: copy.barcode,
    student_name: null,
    staff_name: null,
    issued_by_name: null,
    is_overdue: false,
    fine: null,
  };
}

export async function returnBook(
  borrowRecordId: string,
  copyId: string
): Promise<void> {
  const now = new Date().toISOString();

  const { error: returnErr } = await supabase
    .from('borrow_records')
    .update({ returned_at: now })
    .eq('id', borrowRecordId);

  if (returnErr) throw new Error(friendlyError(returnErr, 'Failed to record return'));

  const { error: copyErr } = await supabase
    .from('book_copies')
    .update({ status: 'available' })
    .eq('id', copyId);

  if (copyErr) throw new Error('Return recorded but copy status could not be updated — please update manually.');
}

// ─── Library Fines ────────────────────────────────────────────────────────────

export async function createFine(
  schoolId: string,
  input: FineInput
): Promise<LibraryFine> {
  const { data, error } = await supabase
    .from('library_fines')
    .insert({
      school_id: schoolId,
      borrow_record_id: input.borrow_record_id,
      amount: input.amount,
      status: 'unpaid',
    })
    .select('id, school_id, borrow_record_id, amount, status, created_at')
    .single();

  if (error) throw new Error(friendlyError(error, 'Failed to create fine'));
  return data as LibraryFine;
}

export async function updateFineStatus(
  fineId: string,
  status: LibraryFine['status']
): Promise<void> {
  const { error } = await supabase
    .from('library_fines')
    .update({ status })
    .eq('id', fineId);

  if (error) throw new Error(friendlyError(error, 'Failed to update fine'));
}

export async function loadUnpaidFines(schoolId: string): Promise<(LibraryFine & { borrower_name: string; book_title: string })[]> {
  const { data, error } = await supabase
    .from('library_fines')
    .select(`
      id, school_id, borrow_record_id, amount, status, created_at,
      borrow_records(
        due_date,
        book_copies(book_titles(title)),
        students(full_name),
        staff!borrow_records_staff_id_fkey(full_name)
      )
    `)
    .eq('school_id', schoolId)
    .eq('status', 'unpaid')
    .order('created_at', { ascending: false });

  if (error) throw new Error(friendlyError(error, 'Failed to load fines'));

  return (data ?? []).map((f) => {
    const br = (f.borrow_records as unknown as Record<string, unknown>[] | null)?.[0] ?? null;
    const copy = br?.book_copies as Record<string, unknown> | null;
    const bt = copy?.book_titles as { title: string } | null;
    const student = br?.students as { full_name: string } | null;
    const staff = br?.staff as { full_name: string } | null;

    return {
      id: f.id,
      school_id: f.school_id,
      borrow_record_id: f.borrow_record_id,
      amount: f.amount,
      status: f.status as LibraryFine['status'],
      created_at: f.created_at,
      borrower_name: student?.full_name ?? staff?.full_name ?? 'Unknown',
      book_title: bt?.title ?? 'Unknown title',
    };
  });
}

// ─── Copy lookup by barcode ───────────────────────────────────────────────────

export async function findCopyByBarcode(
  schoolId: string,
  barcode: string
): Promise<(BookCopy & { title: string }) | null> {
  const { data, error } = await supabase
    .from('book_copies')
    .select('id, school_id, book_title_id, barcode, condition, status, created_at, book_titles(title)')
    .eq('school_id', schoolId)
    .eq('barcode', barcode.trim())
    .maybeSingle();

  if (error) throw new Error(friendlyError(error, 'Barcode lookup failed'));
  if (!data) return null;

  const bt = (data.book_titles as unknown as { title: string }[] | null)?.[0] ?? null;

  return {
    ...(data as BookCopy),
    title: bt?.title ?? 'Unknown title',
  };
}

// ─── Digital Resources ────────────────────────────────────────────────────────

export async function loadDigitalResources(
  filterTagId?: string
): Promise<DigitalResource[]> {
  let query = supabase
    .from('digital_resources')
    .select(`
      id, title, description, resource_type, file_url, embed_url,
      uploaded_by, created_at, updated_at,
      digital_resource_tags(resource_subject_tags(id, name))
    `)
    .order('created_at', { ascending: false });

  if (filterTagId) {
    // Filter via the junction table
    const { data: taggedIds, error: tagErr } = await supabase
      .from('digital_resource_tags')
      .select('resource_id')
      .eq('tag_id', filterTagId);

    if (tagErr) throw new Error(friendlyError(tagErr, 'Failed to filter by tag'));

    const ids = (taggedIds ?? []).map((r) => r.resource_id as string);
    if (ids.length === 0) return [];

    query = query.in('id', ids);
  }

  const { data, error } = await query;
  if (error) throw new Error(friendlyError(error, 'Failed to load digital resources'));

  return (data ?? []).map((r) => {
    const tagRows = (r.digital_resource_tags ?? []) as unknown as { resource_subject_tags: { id: string; name: string } | null }[];
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      resource_type: r.resource_type as DigitalResource['resource_type'],
      file_url: r.file_url,
      embed_url: r.embed_url,
      uploaded_by: r.uploaded_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tags: tagRows
        .map((t) => t.resource_subject_tags?.name ?? '')
        .filter(Boolean),
    };
  });
}

export async function loadSubjectTags(): Promise<SubjectTag[]> {
  const { data, error } = await supabase
    .from('resource_subject_tags')
    .select('id, name')
    .order('name');

  if (error) throw new Error(friendlyError(error, 'Failed to load tags'));
  return (data ?? []) as SubjectTag[];
}

// ─── Summary stats for admin ──────────────────────────────────────────────────

export interface LibraryStats {
  total_titles: number;
  total_copies: number;
  available_copies: number;
  borrowed_copies: number;
  overdue_count: number;
  unpaid_fines: number;
}

export async function loadLibraryStats(schoolId: string): Promise<LibraryStats> {
  const today = new Date().toISOString().slice(0, 10);

  const [titlesRes, copiesRes, overdueRes, finesRes] = await Promise.all([
    supabase
      .from('book_titles')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId),
    supabase
      .from('book_copies')
      .select('id, status')
      .eq('school_id', schoolId),
    supabase
      .from('borrow_records')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .is('returned_at', null)
      .lt('due_date', today),
    supabase
      .from('library_fines')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('status', 'unpaid'),
  ]);

  const copies = (copiesRes.data ?? []) as { status: string }[];

  return {
    total_titles: titlesRes.count ?? 0,
    total_copies: copies.length,
    available_copies: copies.filter((c) => c.status === 'available').length,
    borrowed_copies: copies.filter((c) => c.status === 'borrowed').length,
    overdue_count: overdueRes.count ?? 0,
    unpaid_fines: finesRes.count ?? 0,
  };
}
