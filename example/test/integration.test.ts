/**
 * Integration Test Suite for COG Generated Backend
 *
 * This test suite starts the example server in-process, runs comprehensive
 * API tests covering CRUD operations, relationships, filtering, and field
 * exposure/acceptance controls, then cleans up all test data.
 *
 * Prerequisites:
 * - Database must be initialized: deno task db:init
 * - DATABASE_URL must be set in .env or via environment variable
 *
 * Usage: deno task test:integration
 */

import { assert, assertEquals, assertExists, assertMatch } from '@std/assert';
import { eq } from 'drizzle-orm';
import {
  type AcceptanceTestEntity,
  type Assignment,
  type Department,
  type Employee,
  type ExposureTestEntity,
  exposuretestentityDomain,
  exposuretestentityTable,
  getSQL,
  type IDCard,
  InvalidFilterException,
  type Project,
  type Skill,
  SkillDomain,
  skillDomain,
  withNestedTransaction,
  withoutTransaction,
  withTransaction,
} from '../generated/index.ts';
import { hookCalls } from '../src/hook-probe.ts';
import { type ServerHandle, startServer } from '../src/main.ts';

// ============================================================================
// HTTP Client & Test Utilities
// ============================================================================

const BASE_URL = Deno.env.get('TEST_BASE_URL') || 'http://localhost:3000';
const SERVER_STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 500;

async function GET<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GET ${path} failed: ${response.status} ${error}`);
  }

  const json = await response.json();
  if (json.pagination !== undefined) {
    return json;
  }
  return json.data || json;
}

async function POST<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`POST ${path} failed: ${response.status} ${error}`);
  }

  const json = await response.json();
  return json.data;
}

async function PUT<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PUT ${path} failed: ${response.status} ${error}`);
  }

  const json = await response.json();
  return json.data;
}

async function DELETE<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DELETE ${path} failed: ${response.status} ${error}`);
  }

  const json = await response.json();
  return json.data;
}

async function REQUEST(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; data?: unknown; error?: string }> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.ok) {
    const json = await response.json();
    return { status: response.status, ok: true, data: json.data };
  } else {
    const errorText = await response.text();
    let error = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      error = errorJson.error || errorText;
    } catch {
      // Keep errorText as-is if not JSON
    }
    return { status: response.status, ok: false, error };
  }
}

function encodeFilter(filter: unknown): string {
  return btoa(JSON.stringify(filter));
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIsUUID(value: string, fieldName: string): void {
  assertMatch(value, UUID_REGEX, `${fieldName} should be a valid UUID`);
}

function assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
  assert(Array.isArray(value), `${fieldName} should be an array, got: ${typeof value}`);
}

function logSection(title: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function logStep(step: string): void {
  console.log(`\n> ${step}`);
}

function logSuccess(message: string): void {
  console.log(`  ${message}`);
}

function logData(label: string, data: unknown): void {
  console.log(`  ${label}:`, JSON.stringify(data, null, 2).split('\n').slice(0, 10).join('\n  '));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for work that is not awaited by its caller (after* hooks) to reach a state
 */
const waitUntil = async (condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await sleep(20);
  }
};

// ============================================================================
// Test Types
// ============================================================================

type EmployeeWithRelations = Employee & {
  department?: Department;
  skillList?: Skill[];
  assignmentList?: Assignment[];
  idCard?: IDCard;
};

type DepartmentWithRelations = Department & {
  employeeList?: Employee[];
};

// Store created entity IDs for cleanup and relationships
const createdIds = {
  departments: [] as string[],
  employees: [] as string[],
  projects: [] as string[],
  skills: [] as string[],
  assignments: [] as string[],
  idCards: [] as string[],
  exposureTestEntities: [] as string[],
  acceptanceTestEntities: [] as string[],
  softDeleteTestEntities: [] as string[],
  softDeleteParents: [] as string[],
  softDeleteChildren: [] as string[],
  softDeleteTags: [] as string[],
};

// ============================================================================
// Test Suite
// ============================================================================

async function runTests(): Promise<void> {
  console.log('\nStarting API Demo & Test Suite...\n');

  // ========================================
  // 1. CREATE DEPARTMENTS
  // ========================================
  logSection('1. Creating Departments with Spatial Data');

  logStep('Creating Engineering department in San Francisco');
  const engineering = await POST('/api/department', {
    name: 'Engineering',
    location: {
      type: 'Point',
      coordinates: [-122.4194, 37.7749], // San Francisco
    },
  }) as Department;

  assertExists(engineering.id, 'engineering.id');
  assertIsUUID(engineering.id, 'engineering.id');
  assertEquals(engineering.name, 'Engineering', 'Department name should match');
  assertExists(engineering.location, 'engineering.location');
  logSuccess(`Created department: ${engineering.name} (ID: ${engineering.id})`);
  createdIds.departments.push(engineering.id);

  logStep('Creating Marketing department in Los Angeles');
  const marketing = await POST('/api/department', {
    name: 'Marketing',
    location: {
      type: 'Point',
      coordinates: [-118.2437, 34.0522], // Los Angeles
    },
  }) as Department;

  assertExists(marketing.id, 'marketing.id');
  assertEquals(marketing.name, 'Marketing', 'Department name should match');
  logSuccess(`Created department: ${marketing.name} (ID: ${marketing.id})`);
  createdIds.departments.push(marketing.id);

  // ========================================
  // 2. CREATE EMPLOYEES
  // ========================================
  logSection('2. Creating Employees with Foreign Keys');

  logStep('Creating John Doe in Engineering department');
  const john = await POST('/api/employee', {
    firstName: 'John',
    lastName: 'Doe',
    email: 'john.doe@example.com',
    departmentId: engineering.id,
  }) as Employee;

  assertExists(john.id, 'john.id');
  assertIsUUID(john.id, 'john.id');
  assertEquals(john.firstName, 'John', 'First name should match');
  assertEquals(john.email, 'john.doe@example.com', 'Email should match');
  assertEquals(john.departmentId, engineering.id, 'Department FK should match');
  logSuccess(`Created employee: ${john.firstName} ${john.lastName} (ID: ${john.id})`);
  createdIds.employees.push(john.id);

  logStep('Creating Jane Smith in Engineering department');
  const jane = await POST('/api/employee', {
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane.smith@example.com',
    departmentId: engineering.id,
  }) as Employee;

  assertExists(jane.id, 'jane.id');
  assertEquals(jane.departmentId, engineering.id, 'Department FK should match');
  logSuccess(`Created employee: ${jane.firstName} ${jane.lastName} (ID: ${jane.id})`);
  createdIds.employees.push(jane.id);

  logStep('Creating Bob Wilson in Marketing department');
  const bob = await POST('/api/employee', {
    firstName: 'Bob',
    lastName: 'Wilson',
    email: 'bob.wilson@example.com',
    departmentId: marketing.id,
  }) as Employee;

  assertExists(bob.id, 'bob.id');
  assertEquals(bob.departmentId, marketing.id, 'Department FK should match');
  logSuccess(`Created employee: ${bob.firstName} ${bob.lastName} (ID: ${bob.id})`);
  createdIds.employees.push(bob.id);

  // ========================================
  // 3. CREATE SKILLS
  // ========================================
  logSection('3. Creating Skills');

  const skillNames = ['TypeScript', 'PostgreSQL', 'Deno', 'React', 'Docker'];
  const skills = [];

  for (const skillName of skillNames) {
    logStep(`Creating skill: ${skillName}`);
    const skill = await POST('/api/skill', { name: skillName }) as Skill;

    assertExists(skill.id, `skill.id for ${skillName}`);
    assertEquals(skill.name, skillName, 'Skill name should match');
    logSuccess(`Created skill: ${skill.name} (ID: ${skill.id})`);

    skills.push(skill);
    createdIds.skills.push(skill.id);
  }

  // ========================================
  // 4. ADD SKILLS TO EMPLOYEES (Many-to-Many)
  // ========================================
  logSection('4. Adding Skills to Employees (Many-to-Many)');

  logStep('Adding TypeScript and PostgreSQL skills to John');
  await POST(`/api/employee/${john.id}/skillList`, {
    ids: [skills[0].id, skills[1].id], // TypeScript, PostgreSQL
  });
  logSuccess('Skills added successfully');

  logStep('Verifying John has 2 skills');
  const johnSkills = await GET<unknown[]>(`/api/employee/${john.id}/skillList`);
  assertArray(johnSkills, 'johnSkills');
  assertEquals(johnSkills.length, 2, 'John should have 2 skills');
  logSuccess('Verified skill count');

  logStep('Adding React and Docker skills to Jane');
  await POST(`/api/employee/${jane.id}/skillList`, {
    ids: [skills[3].id, skills[4].id], // React, Docker
  });
  logSuccess('Skills added successfully');

  // ========================================
  // 5. CREATE ID CARDS (One-to-One)
  // ========================================
  logSection('5. Creating ID Cards (One-to-One Relationship)');

  logStep('Creating ID card for John');
  const johnCard = await POST('/api/idcard', {
    employeeId: john.id,
    cardNumber: 'EMP-001',
    issueDate: new Date('2024-01-01').getTime(),
    expiryDate: new Date('2029-01-01').getTime(),
  }) as IDCard;

  assertExists(johnCard.id, 'johnCard.id');
  assertEquals(johnCard.employeeId, john.id, 'Employee FK should match');
  assertEquals(johnCard.cardNumber, 'EMP-001', 'Card number should match');
  logSuccess(`Created ID card: ${johnCard.cardNumber} for ${john.firstName}`);
  createdIds.idCards.push(johnCard.id);

  // ========================================
  // 6. CREATE MENTOR RELATIONSHIPS (Self-Referential Many-to-Many)
  // ========================================
  logSection('6. Creating Mentor Relationships (Self-Referential)');

  logStep('Making John a mentor of Jane');
  await POST(`/api/employee/${john.id}/menteeList`, {
    ids: [jane.id],
  });
  logSuccess('Mentor relationship created');

  logStep('Verifying John has 1 mentee');
  const johnMentees = await GET<unknown[]>(`/api/employee/${john.id}/menteeList`);
  assertArray(johnMentees, 'johnMentees');
  assertEquals(johnMentees.length, 1, 'John should have 1 mentee');
  logSuccess('Verified mentee relationship');

  // ========================================
  // 7. CREATE PROJECTS
  // ========================================
  logSection('7. Creating Projects with Spatial Boundaries');

  logStep('Creating Mobile App project');
  const mobileApp = await POST('/api/project', {
    name: 'Mobile App Redesign',
    boundary: {
      type: 'Polygon',
      coordinates: [[
        [-122.5, 37.7],
        [-122.3, 37.7],
        [-122.3, 37.8],
        [-122.5, 37.8],
        [-122.5, 37.7],
      ]],
    },
  }) as Project;

  assertExists(mobileApp.id, 'mobileApp.id');
  assertEquals(mobileApp.name, 'Mobile App Redesign', 'Project name should match');
  logSuccess(`Created project: ${mobileApp.name} (ID: ${mobileApp.id})`);
  createdIds.projects.push(mobileApp.id);

  logStep('Creating Backend API project');
  const backendAPI = await POST('/api/project', {
    name: 'Backend API Development',
    boundary: {
      type: 'Polygon',
      coordinates: [[
        [-118.3, 34.0],
        [-118.1, 34.0],
        [-118.1, 34.1],
        [-118.3, 34.1],
        [-118.3, 34.0],
      ]],
    },
  }) as Project;

  assertExists(backendAPI.id, 'backendAPI.id');
  logSuccess(`Created project: ${backendAPI.name} (ID: ${backendAPI.id})`);
  createdIds.projects.push(backendAPI.id);

  // ========================================
  // 8. CREATE ASSIGNMENTS (Employee-Project Junction)
  // ========================================
  logSection('8. Creating Assignments (Employee-Project Relationships)');

  logStep('Assigning John to Mobile App project as Lead Developer');
  const assignment1 = await POST('/api/assignment', {
    employeeId: john.id,
    projectId: mobileApp.id,
    role: 'Lead Developer',
    hours: 40,
  }) as Assignment;

  assertExists(assignment1.id, 'assignment1.id');
  assertEquals(assignment1.employeeId, john.id, 'Employee FK should match');
  assertEquals(assignment1.projectId, mobileApp.id, 'Project FK should match');
  assertEquals(assignment1.role, 'Lead Developer', 'Role should match');
  logSuccess('Assignment created');
  createdIds.assignments.push(assignment1.id);

  logStep('Assigning Jane to Backend API project as Developer');
  const assignment2 = await POST('/api/assignment', {
    employeeId: jane.id,
    projectId: backendAPI.id,
    role: 'Developer',
    hours: 35,
  }) as Assignment;

  assertExists(assignment2.id, 'assignment2.id');
  logSuccess('Assignment created');
  createdIds.assignments.push(assignment2.id);

  logStep('Assigning Bob to Mobile App project as Designer');
  const assignment3 = await POST('/api/assignment', {
    employeeId: bob.id,
    projectId: mobileApp.id,
    role: 'UI/UX Designer',
    hours: 30,
  }) as Assignment;

  assertExists(assignment3.id, 'assignment3.id');
  logSuccess('Assignment created');
  createdIds.assignments.push(assignment3.id);

  // ========================================
  // 9. QUERY WITH INCLUDES
  // ========================================
  logSection('9. Querying with Relationship Includes');

  logStep('Getting John with department and skills included');
  const johnFull = await GET(`/api/employee/${john.id}?include=department,skillList`) as EmployeeWithRelations;

  assertExists(johnFull.department, 'johnFull.department');
  assertEquals(johnFull.department!.name, 'Engineering', 'Department name should match');
  assertArray(johnFull.skillList, 'johnFull.skillList');
  assertEquals(johnFull.skillList!.length, 2, 'Should have 2 skills included');
  logSuccess('Successfully loaded employee with relationships');
  logData('John with relationships', johnFull);

  logStep('Getting department with employee list');
  const engWithEmployees = await GET(
    `/api/department/${engineering.id}?include=employeeList`,
  ) as DepartmentWithRelations;

  assertArray(engWithEmployees.employeeList, 'engWithEmployees.employeeList');
  assertEquals(engWithEmployees.employeeList!.length, 2, 'Engineering should have 2 employees');
  logSuccess('Successfully loaded department with employees');

  // ========================================
  // 10. UPDATE OPERATIONS
  // ========================================
  logSection('10. Testing Update Operations');

  logStep("Updating John's first name to Johnny");
  const updatedJohn = await PUT(`/api/employee/${john.id}`, {
    firstName: 'Johnny',
  }) as Employee;

  assertEquals(updatedJohn.id, john.id, 'ID should not change');
  assertEquals(updatedJohn.firstName, 'Johnny', 'First name should be updated');
  assertEquals(updatedJohn.lastName, john.lastName, 'Last name should remain unchanged');
  logSuccess('Employee updated successfully');

  logStep('Updating assignment hours');
  const updatedAssignment = await PUT(`/api/assignment/${assignment1.id}`, {
    hours: 45,
  }) as Assignment;

  assertEquals(updatedAssignment.hours, 45, 'Hours should be updated');
  logSuccess('Assignment updated successfully');

  // ========================================
  // 10.5. ERROR HANDLING - 404 NOT FOUND
  // ========================================
  logSection('10.5. Testing 404 Error Handling');

  // Test UPDATE with non-existent ID
  logStep('Attempting to update non-existent employee (should return 404)');
  const fakeEmployeeId = crypto.randomUUID();
  const updateResponse = await REQUEST('PUT', `/api/employee/${fakeEmployeeId}`, {
    firstName: 'Should',
    lastName: 'Fail',
  });

  assertEquals(updateResponse.status, 404, 'Should return HTTP 404');
  assertEquals(updateResponse.ok, false, 'Response should not be ok');
  assertExists(updateResponse.error, 'Error message should exist');
  assert(
    updateResponse.error!.includes(fakeEmployeeId),
    'Error message should include the entity ID',
  );
  logSuccess(`✓ UPDATE returned 404 for non-existent employee: ${updateResponse.error}`);

  // Test DELETE with non-existent ID
  logStep('Attempting to delete non-existent employee (should return 404)');
  const deleteResponse = await REQUEST('DELETE', `/api/employee/${fakeEmployeeId}`);

  assertEquals(deleteResponse.status, 404, 'Should return HTTP 404');
  assertEquals(deleteResponse.ok, false, 'Response should not be ok');
  assertExists(deleteResponse.error, 'Error message should exist');
  assert(
    deleteResponse.error!.includes(fakeEmployeeId),
    'Error message should include the entity ID',
  );
  logSuccess(`✓ DELETE returned 404 for non-existent employee: ${deleteResponse.error}`);

  // Test GET with non-existent ID (should also return 404)
  logStep('Attempting to get non-existent employee (should return 404)');
  const getResponse = await REQUEST('GET', `/api/employee/${fakeEmployeeId}`);

  assertEquals(getResponse.status, 404, 'Should return HTTP 404');
  assertEquals(getResponse.ok, false, 'Response should not be ok');
  assertExists(getResponse.error, 'Error message should exist');
  logSuccess(`✓ GET returned 404 for non-existent employee: ${getResponse.error}`);

  logSuccess('All 404 error handling tests passed!');

  // ========================================
  // 11. PAGINATION AND ORDERING
  // ========================================
  logSection('11. Testing Pagination and Ordering');

  logStep('Getting employees with pagination (limit=2, offset=0)');
  const page1 = await GET<{ data: unknown[]; pagination: { total: number } }>('/api/employee?limit=2&offset=0');

  assertArray(page1.data, 'page1.data');
  assertEquals(page1.data.length, 2, 'Should return 2 employees');
  assert(page1.pagination.total >= 3, `Total (${page1.pagination.total}) should be >= 3`);
  logSuccess(`Got page 1: ${page1.data.length} employees out of ${page1.pagination.total} total`);

  logStep('Getting employees ordered by lastName ascending');
  const ordered = await GET<{ data: Array<{ lastName: string }> }>(
    '/api/employee?orderBy=lastName&orderDirection=asc',
  );

  assertArray(ordered.data, 'ordered.data');
  assert(ordered.data.length > 0, `Should have employees, got ${ordered.data.length}`);
  logSuccess('Employees ordered successfully');

  // ========================================
  // 12. LIST OPERATIONS
  // ========================================
  logSection('12. Testing List Operations');

  logStep('Listing all departments');
  const allDepts = await GET<{ data: unknown[] }>('/api/department');

  assertArray(allDepts.data, 'allDepts.data');
  assert(allDepts.data.length >= 2, `Should have at least 2 departments, got ${allDepts.data.length}`);
  logSuccess(`Found ${allDepts.data.length} departments`);

  logStep('Listing all projects');
  const allProjects = await GET<{ data: unknown[] }>('/api/project');

  assertArray(allProjects.data, 'allProjects.data');
  assert(allProjects.data.length >= 2, `Should have at least 2 projects, got ${allProjects.data.length}`);
  logSuccess(`Found ${allProjects.data.length} projects`);

  // ========================================
  // 13. MANY-TO-MANY RELATIONSHIP QUERIES
  // ========================================
  logSection('13. Querying Many-to-Many Relationship Endpoints');

  logStep("Getting John's skills via many-to-many endpoint");
  const johnSkillsViaEndpoint = await GET<unknown[]>(`/api/employee/${john.id}/skillList`);

  assertArray(johnSkillsViaEndpoint, 'johnSkillsViaEndpoint');
  assertEquals(johnSkillsViaEndpoint.length, 2, 'John should have 2 skills');
  logSuccess(`Found ${johnSkillsViaEndpoint.length} skills for John via many-to-many endpoint`);

  logStep("Getting John's mentees via self-referential many-to-many endpoint");
  const johnMenteesViaEndpoint = await GET<unknown[]>(`/api/employee/${john.id}/menteeList`);

  assertArray(johnMenteesViaEndpoint, 'johnMenteesViaEndpoint');
  assertEquals(johnMenteesViaEndpoint.length, 1, 'John should have 1 mentee');
  logSuccess(`Found ${johnMenteesViaEndpoint.length} mentees for John via many-to-many endpoint`);

  // ========================================
  // 12. ENDPOINT CONFIGURATION TESTS
  // ========================================
  logSection('12. Testing Endpoint Configuration (RestrictedEntity)');

  logStep('Testing that all RestrictedEntity endpoints are disabled');

  // Test readMany endpoint (GET /api/restrictedentity)
  logStep('Attempting to list RestrictedEntity (should return 404)');
  const listResponse = await REQUEST('GET', '/api/restrictedentity');
  assertEquals(listResponse.status, 404, 'GET /api/restrictedentity should return HTTP 404');
  assertEquals(listResponse.ok, false, 'Response should not be ok');
  logSuccess('✓ List endpoint correctly returns 404 (disabled)');

  // Test create endpoint (POST /api/restrictedentity)
  logStep('Attempting to create RestrictedEntity (should return 404)');
  const createResponse = await REQUEST('POST', '/api/restrictedentity', {
    name: 'Test Entity',
  });
  assertEquals(createResponse.status, 404, 'POST /api/restrictedentity should return HTTP 404');
  assertEquals(createResponse.ok, false, 'Response should not be ok');
  logSuccess('✓ Create endpoint correctly returns 404 (disabled)');

  // Test readOne endpoint (GET /api/restrictedentity/:id)
  logStep('Attempting to get RestrictedEntity by ID (should return 404)');
  const testId = crypto.randomUUID();
  const getOneResponse = await REQUEST('GET', `/api/restrictedentity/${testId}`);
  assertEquals(getOneResponse.status, 404, 'GET /api/restrictedentity/:id should return HTTP 404');
  assertEquals(getOneResponse.ok, false, 'Response should not be ok');
  logSuccess('✓ Get-by-ID endpoint correctly returns 404 (disabled)');

  // Test update endpoint (PUT /api/restrictedentity/:id)
  logStep('Attempting to update RestrictedEntity (should return 404)');
  const updateRestrictedResponse = await REQUEST('PUT', `/api/restrictedentity/${testId}`, {
    name: 'Updated Name',
  });
  assertEquals(updateRestrictedResponse.status, 404, 'PUT /api/restrictedentity/:id should return HTTP 404');
  assertEquals(updateRestrictedResponse.ok, false, 'Response should not be ok');
  logSuccess('✓ Update endpoint correctly returns 404 (disabled)');

  // Test delete endpoint (DELETE /api/restrictedentity/:id)
  logStep('Attempting to delete RestrictedEntity (should return 404)');
  const deleteRestrictedResponse = await REQUEST('DELETE', `/api/restrictedentity/${testId}`);
  assertEquals(deleteRestrictedResponse.status, 404, 'DELETE /api/restrictedentity/:id should return HTTP 404');
  assertEquals(deleteRestrictedResponse.ok, false, 'Response should not be ok');
  logSuccess('✓ Delete endpoint correctly returns 404 (disabled)');

  logSuccess('All endpoint configuration tests passed!');

  // ========================================
  // 13. FILTERING
  // ========================================
  logSection('13. Testing Filtering (where parameter)');

  // 13.1 Simple Equality Filter
  logStep('13.1 Filter employees by firstName (eq)');
  const filteredByFirstName = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'firstName', op: 'eq', value: 'Jane' })}`,
  );
  assertArray(filteredByFirstName.data, 'filteredByFirstName.data');
  assertEquals(filteredByFirstName.data.length, 1, 'Should find exactly 1 employee named Jane');
  assertEquals((filteredByFirstName.data[0] as Employee).firstName, 'Jane', 'Should be Jane');
  logSuccess('✓ Simple equality filter works');

  // 13.2 Numeric Comparison (gte)
  logStep('13.2 Filter employees created after a timestamp (gte)');
  const timestampBefore = Date.now() - 60000; // 1 minute ago
  const filteredByDate = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'createdAt', op: 'gte', value: timestampBefore })}`,
  );
  assertArray(filteredByDate.data, 'filteredByDate.data');
  assert(filteredByDate.data.length >= 1, `Should find employees created recently, got ${filteredByDate.data.length}`);
  logSuccess('✓ Numeric comparison filter (gte) works');

  // 13.3 Pattern Matching (ilike) - case insensitive
  logStep('13.3 Filter employees by email pattern (ilike)');
  const filteredByEmail = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'email', op: 'ilike', value: '%@example.com' })}`,
  );
  assertArray(filteredByEmail.data, 'filteredByEmail.data');
  assert(
    filteredByEmail.data.length >= 3,
    `Should find all employees with @example.com emails, got ${filteredByEmail.data.length}`,
  );
  logSuccess('✓ Pattern matching filter (ilike) works');

  // 13.4 IN Operator
  logStep('13.4 Filter employees by firstName IN list');
  const filteredByIn = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'firstName', op: 'in', value: ['Jane', 'Bob'] })}`,
  );
  assertArray(filteredByIn.data, 'filteredByIn.data');
  assertEquals(filteredByIn.data.length, 2, 'Should find Jane and Bob');
  const names = filteredByIn.data.map((e) => (e as Employee).firstName).sort();
  assert(names.includes('Jane') && names.includes('Bob'), 'Should include Jane and Bob');
  logSuccess('✓ IN operator filter works');

  // 13.5 Nested AND Filter
  logStep('13.5 Filter with AND (department AND firstName)');
  const filteredByAnd = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${
      encodeFilter({
        and: [
          { field: 'departmentId', op: 'eq', value: engineering.id },
          { field: 'firstName', op: 'eq', value: 'Jane' },
        ],
      })
    }`,
  );
  assertArray(filteredByAnd.data, 'filteredByAnd.data');
  assertEquals(filteredByAnd.data.length, 1, 'Should find only Jane in Engineering');
  assertEquals((filteredByAnd.data[0] as Employee).firstName, 'Jane', 'Should be Jane');
  assertEquals((filteredByAnd.data[0] as Employee).departmentId, engineering.id, 'Should be in Engineering');
  logSuccess('✓ Nested AND filter works');

  // 13.6 Nested OR Filter
  logStep('13.6 Filter with OR (firstName OR firstName)');
  const filteredByOr = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${
      encodeFilter({
        or: [
          { field: 'firstName', op: 'eq', value: 'Jane' },
          { field: 'firstName', op: 'eq', value: 'Bob' },
        ],
      })
    }`,
  );
  assertArray(filteredByOr.data, 'filteredByOr.data');
  assertEquals(filteredByOr.data.length, 2, 'Should find Jane and Bob via OR');
  logSuccess('✓ Nested OR filter works');

  // 13.7 Complex Nested AND/OR
  logStep('13.7 Filter with complex AND/OR nesting');
  const filteredComplex = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${
      encodeFilter({
        and: [
          { field: 'departmentId', op: 'eq', value: engineering.id },
          {
            or: [
              { field: 'firstName', op: 'eq', value: 'Johnny' }, // Updated John -> Johnny earlier
              { field: 'firstName', op: 'eq', value: 'Jane' },
            ],
          },
        ],
      })
    }`,
  );
  assertArray(filteredComplex.data, 'filteredComplex.data');
  assertEquals(filteredComplex.data.length, 2, 'Should find Johnny and Jane in Engineering');
  logSuccess('✓ Complex nested AND/OR filter works');

  // 13.8 isNull Operator - Test on createdAt (never null for existing records)
  logStep('13.8 Test isNull operator');

  // Filter employees where createdAt is NOT null (all employees should match)
  const employeesCreatedAtNotNull = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'createdAt', op: 'isNull', value: false })}`,
  );
  assertArray(employeesCreatedAtNotNull.data, 'employeesCreatedAtNotNull.data');
  assert(
    employeesCreatedAtNotNull.data.length >= 3,
    `Should find all employees (createdAt is never null), got ${employeesCreatedAtNotNull.data.length}`,
  );
  logSuccess('✓ isNull: false filter works');

  // Filter employees where createdAt IS null (none should match)
  const employeesCreatedAtNull = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'createdAt', op: 'isNull', value: true })}`,
  );
  assertArray(employeesCreatedAtNull.data, 'employeesCreatedAtNull.data');
  assertEquals(employeesCreatedAtNull.data.length, 0, 'Should find no employees with null createdAt');
  assertEquals(employeesCreatedAtNull.pagination.total, 0, 'Total should be 0');
  logSuccess('✓ isNull: true filter works');

  // 13.9 Filter with Pagination
  logStep('13.9 Filter with pagination');
  const filteredWithPagination = await GET<
    { data: Employee[]; pagination: { total: number; limit: number; offset: number } }
  >(
    `/api/employee?where=${encodeFilter({ field: 'departmentId', op: 'eq', value: engineering.id })}&limit=1&offset=0`,
  );
  assertArray(filteredWithPagination.data, 'filteredWithPagination.data');
  assertEquals(filteredWithPagination.data.length, 1, 'Should return 1 employee (limit=1)');
  assertEquals(filteredWithPagination.pagination.total, 2, 'Total should be 2 (Johnny and Jane in Engineering)');
  assertEquals(filteredWithPagination.pagination.limit, 1, 'Limit should be 1');
  logSuccess('✓ Filter with pagination works');

  // 13.10 Filter with Include
  logStep('13.10 Filter with include');
  const filteredWithInclude = await GET<{ data: EmployeeWithRelations[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'firstName', op: 'eq', value: 'Jane' })}&include=department,skillList`,
  );
  assertArray(filteredWithInclude.data, 'filteredWithInclude.data');
  assertEquals(filteredWithInclude.data.length, 1, 'Should find Jane');
  assertExists((filteredWithInclude.data[0] as EmployeeWithRelations).department, 'Department should be included');
  assertArray((filteredWithInclude.data[0] as EmployeeWithRelations).skillList, 'skillList should be included');
  logSuccess('✓ Filter with include works');

  // 13.11 Error Cases
  logStep('13.11 Error cases - Invalid field name');
  const invalidFieldResult = await REQUEST(
    'GET',
    `/api/employee?where=${encodeFilter({ field: 'nonexistent', op: 'eq', value: 'x' })}`,
  );
  assertEquals(invalidFieldResult.status, 400, 'Invalid field should return 400');
  assert(
    (invalidFieldResult.error?.toLowerCase().includes('unknown') ||
      invalidFieldResult.error?.toLowerCase().includes('field')) ?? false,
    'Error should mention unknown field',
  );
  logSuccess('✓ Invalid field returns 400');

  logStep('13.11 Error cases - Malformed base64');
  const malformedBase64Result = await REQUEST('GET', '/api/employee?where=not-valid-base64!!!');
  assertEquals(malformedBase64Result.status, 400, 'Malformed base64 should return 400');
  logSuccess('✓ Malformed base64 returns 400');

  logStep('13.11 Error cases - Invalid JSON');
  const invalidJsonResult = await REQUEST('GET', `/api/employee?where=${btoa('not json')}`);
  assertEquals(invalidJsonResult.status, 400, 'Invalid JSON should return 400');
  logSuccess('✓ Invalid JSON returns 400');

  // 13.12 Empty Filter (no results)
  logStep('13.12 Filter with no matching results');
  const emptyResult = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'firstName', op: 'eq', value: 'NonexistentName12345' })}`,
  );
  assertArray(emptyResult.data, 'emptyResult.data');
  assertEquals(emptyResult.data.length, 0, 'Should return empty array');
  assertEquals(emptyResult.pagination.total, 0, 'Total should be 0');
  logSuccess('✓ Empty filter result works');

  logSuccess('All filtering tests passed!');

  // ========================================
  // 14. FIELD EXPOSURE CONTROL (hidden vs create-only fields)
  // ========================================
  logSection('14. Testing Field Exposure Control (hidden vs create-only fields)');

  // 14.1 POST - verify hiddenField stripped, createOnlyField visible
  logStep('14.1 Create ExposureTestEntity - verify field visibility');
  const exposureEntity = await POST('/api/exposuretestentity', {
    normalField: 'Normal Value',
    hiddenField: 'This should be hidden',
    createOnlyField: 'This should be visible on create only',
  }) as ExposureTestEntity;

  assertExists(exposureEntity.id, 'exposureEntity.id should exist');
  assertEquals(exposureEntity.normalField, 'Normal Value', 'normalField should be present');
  assert(!Object.hasOwn(exposureEntity, 'hiddenField'), 'hiddenField should be stripped from POST response');
  assert(Object.hasOwn(exposureEntity, 'createOnlyField'), 'createOnlyField should be visible in POST response');
  assertEquals(
    (exposureEntity as Record<string, unknown>).createOnlyField,
    'This should be visible on create only',
    'createOnlyField value should match',
  );
  createdIds.exposureTestEntities.push(exposureEntity.id);
  logSuccess('✓ POST: hiddenField stripped, createOnlyField visible');

  // 14.2 GET - verify both hidden and create-only fields stripped
  logStep('14.2 Get ExposureTestEntity by ID - verify both fields stripped');
  const fetchedExposure = await GET<ExposureTestEntity>(`/api/exposuretestentity/${exposureEntity.id}`);
  assertExists(fetchedExposure, 'fetchedExposure should exist');
  assertEquals(fetchedExposure.normalField, 'Normal Value', 'normalField should be present');
  assert(!Object.hasOwn(fetchedExposure, 'hiddenField'), 'hiddenField should be stripped from GET response');
  assert(!Object.hasOwn(fetchedExposure, 'createOnlyField'), 'createOnlyField should be stripped from GET response');
  logSuccess('✓ GET: both hiddenField and createOnlyField stripped');

  // 14.3 PUT - verify both hidden and create-only fields stripped
  logStep('14.3 Update ExposureTestEntity - verify both fields stripped');
  const updatedExposure = await PUT(`/api/exposuretestentity/${exposureEntity.id}`, {
    normalField: 'Updated Normal Value',
  }) as ExposureTestEntity;
  assertEquals(updatedExposure.normalField, 'Updated Normal Value', 'normalField should be updated');
  assert(!Object.hasOwn(updatedExposure, 'hiddenField'), 'hiddenField should be stripped from PUT response');
  assert(!Object.hasOwn(updatedExposure, 'createOnlyField'), 'createOnlyField should be stripped from PUT response');
  logSuccess('✓ PUT: both hiddenField and createOnlyField stripped');

  // 14.4 List - verify both fields stripped from all items
  logStep('14.4 List ExposureTestEntities - verify both fields stripped');
  const exposureList = await GET<{ data: ExposureTestEntity[] }>('/api/exposuretestentity');
  assertArray(exposureList.data, 'exposureList.data should be array');
  assert(exposureList.data.length >= 1, `Should have at least 1 entity, got ${exposureList.data.length}`);
  for (const item of exposureList.data) {
    assert(!Object.hasOwn(item, 'hiddenField'), 'hiddenField should be stripped from list items');
    assert(!Object.hasOwn(item, 'createOnlyField'), 'createOnlyField should be stripped from list items');
  }
  logSuccess('✓ List: both hiddenField and createOnlyField stripped from all items');

  // 14.5 Filter on hiddenField - should return 400
  logStep('14.5 Filter on hiddenField - should return 400');
  const filterHiddenResult = await REQUEST(
    'GET',
    `/api/exposuretestentity?where=${encodeFilter({ field: 'hiddenField', op: 'eq', value: 'x' })}`,
  );
  assertEquals(filterHiddenResult.status, 400, 'Filtering on hiddenField should return 400');
  logSuccess('✓ Filtering on hiddenField returns 400');

  // 14.6 Filter on createOnlyField - should return 400
  logStep('14.6 Filter on createOnlyField - should return 400');
  const filterCreateOnlyResult = await REQUEST(
    'GET',
    `/api/exposuretestentity?where=${encodeFilter({ field: 'createOnlyField', op: 'eq', value: 'x' })}`,
  );
  assertEquals(filterCreateOnlyResult.status, 400, 'Filtering on createOnlyField should return 400');
  logSuccess('✓ Filtering on createOnlyField returns 400');

  // 14.7 Filter on normalField - should succeed
  logStep('14.7 Filter on normalField - should succeed');
  const filterNormalResult = await GET<{ data: ExposureTestEntity[]; pagination: { total: number } }>(
    `/api/exposuretestentity?where=${encodeFilter({ field: 'normalField', op: 'eq', value: 'Updated Normal Value' })}`,
  );
  assertArray(filterNormalResult.data, 'filterNormalResult.data');
  assert(filterNormalResult.data.length >= 1, `Should find at least 1 entity, got ${filterNormalResult.data.length}`);
  logSuccess('✓ Filtering on normalField works correctly');

  logSuccess('All field exposure tests passed!');

  // ========================================
  // 15. FIELD ACCEPTANCE CONTROL (input stripping)
  // ========================================
  logSection('15. Testing Field Acceptance Control (input stripping)');

  // 15.1 POST - verify neverAcceptedField stripped, createOnlyField accepted
  logStep('15.1 Create AcceptanceTestEntity - verify input stripping');
  const customId = crypto.randomUUID();
  const acceptanceEntity = await POST('/api/acceptancetestentity', {
    id: customId, // Should be accepted (primary key implicit accept: create)
    normalField: 'Normal Value',
    createOnlyField: 'Immutable Value',
    neverAcceptedField: 'This should be stripped and use default',
    createdAt: 9999999999999, // Should be stripped (implicit accept: never)
    updatedAt: 9999999999999, // Should be stripped (implicit accept: never)
  }) as AcceptanceTestEntity;

  assertExists(acceptanceEntity.id, 'acceptanceEntity.id should exist');
  assertEquals(acceptanceEntity.id, customId, 'Custom ID should be accepted on POST');
  assertEquals(acceptanceEntity.normalField, 'Normal Value', 'normalField should be accepted');
  assertEquals(acceptanceEntity.createOnlyField, 'Immutable Value', 'createOnlyField should be accepted on POST');
  assertEquals(acceptanceEntity.neverAcceptedField, 'server-generated', 'neverAcceptedField should use default value');
  assert(
    acceptanceEntity.createdAt !== 9999999999999,
    `createdAt (${acceptanceEntity.createdAt}) should be stripped (use DB default, not 9999999999999)`,
  );
  assert(
    acceptanceEntity.updatedAt !== 9999999999999,
    `updatedAt (${acceptanceEntity.updatedAt}) should be stripped (use DB default, not 9999999999999)`,
  );
  createdIds.acceptanceTestEntities.push(acceptanceEntity.id);
  logSuccess('✓ POST: neverAcceptedField/timestamps stripped, id/createOnlyField accepted');

  // 15.2 PUT - verify id, createOnlyField, neverAcceptedField, and timestamps all stripped
  logStep('15.2 Update AcceptanceTestEntity - verify input stripping');
  const originalCreateOnlyField = acceptanceEntity.createOnlyField;
  const originalCreatedAt = acceptanceEntity.createdAt;
  const updatedAcceptance = await PUT(`/api/acceptancetestentity/${acceptanceEntity.id}`, {
    id: crypto.randomUUID(), // Should be stripped (primary key implicit accept: create)
    normalField: 'Updated Normal Value',
    createOnlyField: 'This should be stripped', // Should be stripped (accept: create)
    neverAcceptedField: 'This should also be stripped', // Should be stripped (accept: never)
    createdAt: 1111111111111, // Should be stripped
    updatedAt: 1111111111111, // Should be stripped (but auto-updated)
  }) as AcceptanceTestEntity;

  assertEquals(updatedAcceptance.id, acceptanceEntity.id, 'ID should NOT change on PUT');
  assertEquals(updatedAcceptance.normalField, 'Updated Normal Value', 'normalField should be updated');
  assertEquals(updatedAcceptance.createOnlyField, originalCreateOnlyField, 'createOnlyField should NOT change on PUT');
  assertEquals(updatedAcceptance.neverAcceptedField, 'server-generated', 'neverAcceptedField should NOT change');
  assertEquals(updatedAcceptance.createdAt, originalCreatedAt, 'createdAt should NOT change');
  assert(
    updatedAcceptance.updatedAt !== 1111111111111,
    `updatedAt (${updatedAcceptance.updatedAt}) should be auto-updated, not from input (1111111111111)`,
  );
  assert(
    updatedAcceptance.updatedAt >= updatedAcceptance.createdAt,
    `updatedAt (${updatedAcceptance.updatedAt}) should be >= createdAt (${updatedAcceptance.createdAt})`,
  );
  logSuccess('✓ PUT: id/createOnlyField/neverAcceptedField/timestamps all stripped');

  // 15.3 Verify GET returns all visible fields correctly
  logStep('15.3 Get AcceptanceTestEntity - verify all fields visible');
  const fetchedAcceptance = await GET<AcceptanceTestEntity>(`/api/acceptancetestentity/${acceptanceEntity.id}`);
  assertExists(fetchedAcceptance, 'fetchedAcceptance should exist');
  assertEquals(fetchedAcceptance.id, customId, 'ID should match custom ID');
  assertEquals(fetchedAcceptance.normalField, 'Updated Normal Value', 'normalField should be present');
  assertEquals(fetchedAcceptance.createOnlyField, originalCreateOnlyField, 'createOnlyField should be present');
  assertEquals(fetchedAcceptance.neverAcceptedField, 'server-generated', 'neverAcceptedField should be visible');
  assertExists(fetchedAcceptance.createdAt, 'createdAt should be present');
  assertExists(fetchedAcceptance.updatedAt, 'updatedAt should be present');
  logSuccess('✓ GET: all fields visible (accept controls input, not output)');

  // 15.4 Test that timestamps are always stripped (implicit accept: never)
  logStep('15.4 Verify timestamps stripped on another entity');
  const timestampTestEntity = await POST('/api/acceptancetestentity', {
    normalField: 'Timestamp Test',
  }) as AcceptanceTestEntity;

  assertExists(timestampTestEntity.createdAt, 'createdAt should exist with DB default');
  assertExists(timestampTestEntity.updatedAt, 'updatedAt should exist with DB default');
  const now = Date.now();
  assert(
    Math.abs(timestampTestEntity.createdAt - now) < 5000,
    `createdAt (${timestampTestEntity.createdAt}) should be within 5000ms of now (${now}), diff: ${
      Math.abs(timestampTestEntity.createdAt - now)
    }`,
  );
  assert(
    Math.abs(timestampTestEntity.updatedAt - now) < 5000,
    `updatedAt (${timestampTestEntity.updatedAt}) should be within 5000ms of now (${now}), diff: ${
      Math.abs(timestampTestEntity.updatedAt - now)
    }`,
  );
  createdIds.acceptanceTestEntities.push(timestampTestEntity.id);
  logSuccess('✓ Timestamps automatically set by database, not from input');

  // 15.5 Verify minLength validation (Zod) rejects too-short values with HTTP 400
  logStep('15.5 Create with too-short normalField - verify minLength rejected (400)');
  const tooShortCreate = await REQUEST('POST', '/api/acceptancetestentity', {
    normalField: 'ab', // minLength is 3 - must be rejected
  });
  assertEquals(tooShortCreate.status, 400, 'POST with normalField shorter than minLength should return HTTP 400');

  // 15.6 Verify minLength validation also enforced on update
  logStep('15.6 Update with too-short normalField - verify minLength rejected (400)');
  const tooShortUpdate = await REQUEST('PUT', `/api/acceptancetestentity/${acceptanceEntity.id}`, {
    normalField: 'x', // minLength is 3 - must be rejected
  });
  assertEquals(tooShortUpdate.status, 400, 'PUT with normalField shorter than minLength should return HTTP 400');

  // 15.7 Verify a value at the minLength boundary is accepted
  logStep('15.7 Create with boundary-length normalField - verify accepted');
  const boundaryEntity = await POST('/api/acceptancetestentity', {
    normalField: 'abc', // exactly minLength 3 - must be accepted
  }) as AcceptanceTestEntity;
  assertEquals(boundaryEntity.normalField, 'abc', 'normalField at minLength boundary should be accepted');
  createdIds.acceptanceTestEntities.push(boundaryEntity.id);
  logSuccess('✓ minLength validation: too-short rejected (400) on create/update, boundary value accepted');

  // 15.8 Malformed JSON body is a client error, not a server error
  logStep('15.8 POST with malformed JSON body - verify rejected (400)');
  const malformedBody = await fetch(`${BASE_URL}/api/acceptancetestentity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ "normalField": ',
  });
  await malformedBody.text();
  assertEquals(malformedBody.status, 400, 'POST with a malformed JSON body should return HTTP 400');

  // 15.9 The same on update
  logStep('15.9 PUT with malformed JSON body - verify rejected (400)');
  const malformedUpdate = await fetch(`${BASE_URL}/api/acceptancetestentity/${boundaryEntity.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json at all',
  });
  await malformedUpdate.text();
  assertEquals(malformedUpdate.status, 400, 'PUT with a malformed JSON body should return HTTP 400');
  logSuccess('✓ Malformed JSON body rejected with 400 on create and update');

  logSuccess('All field acceptance tests passed!');

  // ========================================
  // 16. HOOK FILTER COMBINATION (beforeFindMany with and())
  // ========================================
  logSection('16. Testing beforeFindMany Hook Filter Combination');

  // The beforeFindMany hook in main.ts combines the REST filter with isNotNull(departmentId)
  // This test validates that WhereFilter is converted to SQL BEFORE the hook runs
  // If the bug exists (WhereFilter passed to hook), and() would silently fail

  // 16.1 Test filter combination works (REST filter + hook condition)
  logStep('16.1 Filter with hook combination (firstName filter + departmentId not null)');
  const hookFilterResult = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${encodeFilter({ field: 'firstName', op: 'eq', value: 'Jane' })}`,
  );
  assertArray(hookFilterResult.data, 'hookFilterResult.data');
  // Should find Jane (who has a department) - the hook adds isNotNull(departmentId)
  assertEquals(hookFilterResult.data.length, 1, 'Should find exactly 1 employee named Jane with a department');
  const janeFromHook = hookFilterResult.data[0] as Employee;
  assertEquals(janeFromHook.firstName, 'Jane', 'Should find Jane');
  assertExists(janeFromHook.departmentId, 'Jane should have a departmentId (hook condition)');
  logSuccess('✓ beforeFindMany hook successfully combined REST filter with SQL condition');

  // 16.2 Test that hook condition alone works (no REST filter)
  logStep('16.2 List without filter (hook adds departmentId not null)');
  const hookOnlyResult = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee`,
  );
  assertArray(hookOnlyResult.data, 'hookOnlyResult.data');
  // All returned employees should have departmentId (hook adds isNotNull condition)
  for (const emp of hookOnlyResult.data as Employee[]) {
    assertExists(emp.departmentId, `Employee ${emp.firstName} should have departmentId (hook condition)`);
  }
  logSuccess('✓ beforeFindMany hook condition works without REST filter');

  // 16.3 Test complex filter combination
  logStep('16.3 Complex filter with hook (AND group + hook condition)');
  const complexFilterResult = await GET<{ data: Employee[]; pagination: { total: number } }>(
    `/api/employee?where=${
      encodeFilter({
        and: [
          { field: 'firstName', op: 'in', value: ['Jane', 'Bob', 'Alice'] },
          { field: 'email', op: 'ilike', value: '%@example.com' },
        ],
      })
    }`,
  );
  assertArray(complexFilterResult.data, 'complexFilterResult.data');
  // All results should match the REST filter AND have departmentId
  for (const emp of complexFilterResult.data as Employee[]) {
    assert(['Jane', 'Bob', 'Alice'].includes(emp.firstName), `${emp.firstName} should be Jane, Bob, or Alice`);
    assert(emp.email.endsWith('@example.com'), `${emp.email} should end with @example.com`);
    assertExists(emp.departmentId, `Employee ${emp.firstName} should have departmentId (hook condition)`);
  }
  logSuccess('✓ Complex REST filter combined with hook SQL condition');

  logSuccess('All beforeFindMany hook tests passed!');

  // ========================================
  // 17. SOFT DELETE
  // ========================================
  logSection('17. Soft Delete');

  const rawSql = getSQL();

  // 17.1 Create — deletedAt must not be present (hidden field)
  logStep('17.1 Create a soft-delete entity');
  const sd = await POST('/api/softdeletetestentity', { code: 'SD-1', name: 'First' }) as Record<string, unknown>;
  assertExists(sd.id, 'sd.id');
  assertEquals('deletedAt' in sd, false, 'deletedAt must be hidden in responses');
  const sdId = sd.id as string;

  // 17.2 Soft delete — row physically persists with deleted_at set
  logStep('17.2 Soft delete the entity');
  await DELETE(`/api/softdeletetestentity/${sdId}`);
  const rows = await rawSql`SELECT deleted_at FROM soft_delete_test_entity WHERE id = ${sdId}`;
  assertEquals(rows.length, 1, 'row must still physically exist (soft, not hard, delete)');
  assert(rows[0].deleted_at !== null, 'deleted_at must be populated');

  // 17.3 List excludes it
  logStep('17.3 List excludes soft-deleted');
  const list = await GET<{ data: unknown[]; pagination: { total: number } }>('/api/softdeletetestentity');
  assertEquals(list.data.some((r) => (r as { id: string }).id === sdId), false, 'soft-deleted row must not be listed');

  // 17.4 Get by id → 404
  logStep('17.4 Get soft-deleted by id → 404');
  const getRes = await REQUEST('GET', `/api/softdeletetestentity/${sdId}`);
  assertEquals(getRes.status, 404, 'GET soft-deleted must be 404');

  // 17.5 Update locked → 404
  logStep('17.5 Update soft-deleted → 404');
  const putRes = await REQUEST('PUT', `/api/softdeletetestentity/${sdId}`, { name: 'Nope' });
  assertEquals(putRes.status, 404, 'PUT soft-deleted must be 404');

  // 17.6 Re-delete → 404
  logStep('17.6 Re-delete soft-deleted → 404');
  const delRes = await REQUEST('DELETE', `/api/softdeletetestentity/${sdId}`);
  assertEquals(delRes.status, 404, 'second DELETE must be 404');

  // 17.7 Partial unique index — same code can be reused after soft delete
  logStep('17.7 Reuse unique code after soft delete');
  const reused = await POST('/api/softdeletetestentity', { code: 'SD-1', name: 'Reused' }) as Record<string, unknown>;
  assertExists(reused.id, 'reused.id — soft-deleted row must not reserve the unique value');
  createdIds.softDeleteTestEntities = [reused.id as string];
  // two live rows with the same code must still be rejected - a unique violation is a conflict,
  // not a server error
  const dup = await REQUEST('POST', '/api/softdeletetestentity', { code: 'SD-1', name: 'Dup' });
  assertEquals(dup.status, 409, 'duplicate live unique code must be rejected with HTTP 409');

  // 17.8 Timestamp interaction
  logStep('17.8 Timestamps: createdAt preserved, deletedAt recent, updatedAt untouched by soft delete');
  const t = await POST('/api/softdeletetestentity', { code: 'SD-2', name: 'T' }) as Record<string, number | string>;
  const tId = t.id as string;
  const beforeRows = await rawSql`SELECT created_at, updated_at FROM soft_delete_test_entity WHERE id = ${tId}`;
  await DELETE(`/api/softdeletetestentity/${tId}`);
  const afterRows =
    await rawSql`SELECT created_at, updated_at, deleted_at FROM soft_delete_test_entity WHERE id = ${tId}`;
  assertEquals(Number(afterRows[0].created_at), Number(beforeRows[0].created_at), 'createdAt must not change');
  assertEquals(
    Number(afterRows[0].updated_at),
    Number(beforeRows[0].updated_at),
    'updatedAt must NOT advance on soft delete',
  );
  assert(Math.abs(Number(afterRows[0].deleted_at) - Date.now()) < 5000, 'deletedAt must be ~now');
  createdIds.softDeleteTestEntities.push(tId);

  // 17.9 Include excludes soft-deleted child (oneToMany propagation)
  logStep('17.9 ?include=childList excludes soft-deleted children');
  const parent = await POST('/api/softdeleteparent', { name: 'P1' }) as Record<string, unknown>;
  const parentId = parent.id as string;
  const childA = await POST('/api/softdeletechild', { parentId, name: 'A' }) as Record<string, unknown>;
  const childB = await POST('/api/softdeletechild', { parentId, name: 'B' }) as Record<string, unknown>;
  await DELETE(`/api/softdeletechild/${childA.id}`); // soft-delete one child
  const withChildren = await GET<Record<string, unknown>>(`/api/softdeleteparent/${parentId}?include=childList`);
  const childList = withChildren.childList as Array<{ id: string }>;
  assertEquals(childList.length, 1, 'only the live child must be included');
  assertEquals(childList[0].id, childB.id, 'the live child is B');

  // 17.10 many-to-many list excludes soft-deleted target (getJunctionTargets propagation)
  logStep('17.10 GET /:id/tagList excludes soft-deleted tags');
  const tag1 = await POST('/api/softdeletetag', { label: 'T1' }) as Record<string, unknown>;
  const tag2 = await POST('/api/softdeletetag', { label: 'T2' }) as Record<string, unknown>;
  await POST(`/api/softdeleteparent/${parentId}/tag`, { id: tag1.id });
  await POST(`/api/softdeleteparent/${parentId}/tag`, { id: tag2.id });
  await DELETE(`/api/softdeletetag/${tag1.id}`); // soft-delete one tag
  const tagList = await GET<Array<{ id: string }>>(`/api/softdeleteparent/${parentId}/tagList`);
  assertEquals(tagList.length, 1, 'only the live tag must be returned by the m2m list');
  assertEquals(tagList[0].id, tag2.id, 'the live tag is T2');

  // 17.11 manyToOne include resolves correctly: live child still resolves its (live) parent
  logStep('17.11 ?include=parent on a live child returns the parent');
  const childWithParent = await GET<Record<string, unknown>>(`/api/softdeletechild/${childB.id}?include=parent`);
  assertExists((childWithParent.parent as { id?: string })?.id, 'live child must resolve its parent');

  // 17.12 manyToOne include resolves to null when parent is soft-deleted
  logStep('17.12 ?include=parent resolves to null when parent is soft-deleted');
  // Use a dedicated parent so we do not disturb the parent/child/tag rows used above
  const orphanParent = await POST('/api/softdeleteparent', { name: 'OrphanParent' }) as Record<string, unknown>;
  const orphanParentId = orphanParent.id as string;
  const orphanChild = await POST('/api/softdeletechild', { parentId: orphanParentId, name: 'OrphanChild' }) as Record<
    string,
    unknown
  >;
  const orphanChildId = orphanChild.id as string;
  // Soft-delete the parent (UPDATE sets deleted_at; child FK row remains because soft-delete is not CASCADE)
  await DELETE(`/api/softdeleteparent/${orphanParentId}`);
  // The child is still live; its ?include=parent must resolve to null (parent is soft-deleted)
  const orphanChildWithParent = await GET<Record<string, unknown>>(
    `/api/softdeletechild/${orphanChildId}?include=parent`,
  );
  assertEquals(
    orphanChildWithParent.parent as null | { id?: string },
    null,
    'manyToOne include must resolve to null when the parent is soft-deleted',
  );
  logSuccess('✓ manyToOne include resolves to null for soft-deleted parent');
  // Track for cleanup (soft-deleted parent purged by db-clean; live child tracked)
  createdIds.softDeleteParents.push(orphanParentId);
  createdIds.softDeleteChildren.push(orphanChildId);

  createdIds.softDeleteParents = [parentId, orphanParentId];
  createdIds.softDeleteTags = [tag2.id as string];
  createdIds.softDeleteChildren = [childB.id as string, orphanChildId];

  logSuccess('Soft delete behavior verified');

  // ========================================
  // 18. NON-DEFAULT SCHEMA
  // ========================================
  logSection('18. Testing a Model in a Non-Default Schema');

  // AdvancedDemo declares "schema": "analytics". The Drizzle table is wrapped in
  // pgSchema('analytics'), so the DDL has to create the table there too - otherwise every
  // request fails with 'relation "analytics.advanced_demo" does not exist'.
  logStep('18.1 Create an AdvancedDemo record in the analytics schema');
  const advanced = await POST('/api/advanceddemo', {
    name: 'Schema Probe',
    isActive: true,
    optionalField1: 'first',
    optionalField2: 2,
  }) as Record<string, unknown>;
  assertExists(advanced.id, 'advanced.id');

  logStep('18.2 Read it back through the ORM');
  const advancedRead = await GET(`/api/advanceddemo/${advanced.id}`) as Record<string, unknown>;
  assertEquals(advancedRead.name, 'Schema Probe', 'record must be readable from the analytics schema');

  logStep('18.3 Verify the table physically lives in the analytics schema');
  const schemaRows = await rawSql`
    SELECT table_schema FROM information_schema.tables WHERE table_name = 'advanced_demo'
  `;
  assertEquals(schemaRows.length, 1, 'advanced_demo must exist exactly once');
  assertEquals(schemaRows[0].table_schema, 'analytics', 'advanced_demo must live in the analytics schema');

  await DELETE(`/api/advanceddemo/${advanced.id}`);
  logSuccess('✓ Non-default schema: DDL creates the table in analytics and CRUD works there');

  // ========================================
  // 19. REFERENTIAL ACTIONS
  // ========================================
  logSection('19. Testing Foreign Key Referential Actions');

  // IDCard.employeeId declares onDelete CASCADE and Employee.departmentId declares RESTRICT.
  // Without those actions on the generated schema both would silently fall back to NO ACTION.
  logStep('19.1 Deleting an employee cascades to its ID card');
  const fkDept = await POST('/api/department', {
    name: 'Referential Actions Dept',
    location: { type: 'Point', coordinates: [19.04, 47.49] },
  }) as Department;
  const fkEmployee = await POST('/api/employee', {
    firstName: 'Cascade',
    lastName: 'Probe',
    email: 'cascade.probe@example.com',
    departmentId: fkDept.id,
  }) as Employee;
  const fkCard = await POST('/api/idcard', {
    employeeId: fkEmployee.id,
    cardNumber: 'FK-001',
    issueDate: new Date('2024-01-01').getTime(),
    expiryDate: new Date('2029-01-01').getTime(),
  }) as IDCard;

  await DELETE(`/api/employee/${fkEmployee.id}`);
  const cascadedCard = await REQUEST('GET', `/api/idcard/${fkCard.id}`);
  assertEquals(cascadedCard.status, 404, 'onDelete CASCADE must remove the ID card with its employee');

  logStep('19.2 A department with employees cannot be deleted (RESTRICT)');
  const restrictEmployee = await POST('/api/employee', {
    firstName: 'Restrict',
    lastName: 'Probe',
    email: 'restrict.probe@example.com',
    departmentId: fkDept.id,
  }) as Employee;
  const restricted = await REQUEST('DELETE', `/api/department/${fkDept.id}`);
  assertEquals(restricted.status, 409, 'onDelete RESTRICT must refuse the delete with HTTP 409');

  // and it succeeds once nothing references it any more
  await DELETE(`/api/employee/${restrictEmployee.id}`);
  const allowed = await REQUEST('DELETE', `/api/department/${fkDept.id}`);
  assertEquals(allowed.status, 200, 'the department is deletable once no employee references it');

  // AdvancedDemo.relatedId declares onDelete NO ACTION. Both databases report that refusal as 23503
  // (foreign_key_violation) - CockroachDB even reports RESTRICT that way - and on a delete it means
  // the row is still referenced: a conflict, not a malformed request.
  logStep('19.3 A row still referenced through NO ACTION cannot be deleted (409)');
  const noActionTarget = await POST('/api/advanceddemo', {
    name: 'NO ACTION Target',
    optionalField1: 'first',
    optionalField2: 1,
  }) as Record<string, unknown>;
  const noActionSource = await POST('/api/advanceddemo', {
    name: 'NO ACTION Source',
    optionalField1: 'first',
    optionalField2: 1,
    relatedId: noActionTarget.id,
  }) as Record<string, unknown>;
  const stillReferenced = await REQUEST('DELETE', `/api/advanceddemo/${noActionTarget.id}`);
  assertEquals(stillReferenced.status, 409, 'deleting a still referenced row must answer HTTP 409');

  logStep('19.4 A reference to a missing row stays a client error (400)');
  const dangling = await REQUEST('POST', '/api/advanceddemo', {
    name: 'Dangling Reference',
    optionalField1: 'first',
    optionalField2: 1,
    relatedId: crypto.randomUUID(),
  });
  assertEquals(dangling.status, 400, 'a create referencing a missing row must answer HTTP 400');

  await DELETE(`/api/advanceddemo/${noActionSource.id}`);
  await DELETE(`/api/advanceddemo/${noActionTarget.id}`);
  logSuccess('✓ Referential actions: CASCADE removes the child; RESTRICT and NO ACTION block the parent delete');

  // ========================================
  // 20. AFTER HOOKS START ONCE THE TRANSACTION HAS COMMITTED
  // ========================================
  logSection('20. Testing after* Hooks Against the Transaction Outcome');

  // The hook records when it starts and whether a connection of its own can already read the row:
  // that is what a sync started from an after* hook sees.
  const hookStarts: string[] = [];
  const hookSawRow = new Map<string, boolean>();
  const probeDomain = new SkillDomain({
    afterCreate: async (skill: Skill): Promise<void> => {
      hookStarts.push(skill.name);
      const rows = await getSQL()`SELECT id FROM skill WHERE id = ${skill.id}`;
      hookSawRow.set(skill.name, rows.length === 1);
    },
  });
  const probeName = (label: string): string => `after-commit-${crypto.randomUUID().slice(0, 8)}-${label}`;
  const startsOf = (name: string): number => hookStarts.filter((started) => started === name).length;

  logStep('20.1 afterCreate sees the committed row from another connection');
  const committedName = probeName('committed');
  const committed = await withTransaction(async (tx) => {
    const skill = await probeDomain.create({ name: committedName }, tx);
    // Keep the transaction open: a hook started before COMMIT would find nothing
    await sleep(200);
    return skill;
  });
  await waitUntil(() => hookSawRow.has(committedName), 'afterCreate of the committed row');
  assertEquals(hookSawRow.get(committedName), true, 'afterCreate must start after COMMIT');

  logStep('20.2 A rolled-back transaction drops its after* hooks');
  const rolledBackName = probeName('rolled-back');
  const rollbackError = await withTransaction(async (tx) => {
    await probeDomain.create({ name: rolledBackName }, tx);
    throw new Error('rollback probe');
  }).catch((error: unknown) => error);
  assert(rollbackError instanceof Error && rollbackError.message === 'rollback probe', 'the rollback error surfaces');
  await sleep(300);
  assertEquals(startsOf(rolledBackName), 0, 'a rolled-back create must not run afterCreate');

  logStep('20.3 A retried attempt drops the hooks of the failed one');
  const retriedName = probeName('retried');
  let attempts = 0;
  const retried = await withTransaction(async (tx) => {
    const skill = await probeDomain.create({ name: retriedName }, tx);
    attempts++;
    if (attempts === 1) {
      // What PostgreSQL and CockroachDB raise on a serialization conflict
      throw Object.assign(new Error('serialization probe'), { code: '40001' });
    }
    return skill;
  });
  await waitUntil(() => hookSawRow.has(retriedName), 'afterCreate of the retried create');
  await sleep(100);
  assertEquals(attempts, 2, 'the serialization failure is retried');
  assertEquals(startsOf(retriedName), 1, 'afterCreate runs once, for the attempt that committed');

  logStep('20.4 A savepoint hands its hooks to the parent, a failed savepoint drops them');
  const parentName = probeName('parent');
  const nestedName = probeName('nested');
  const failedNestedName = probeName('nested-failed');
  const nestedIds = await withTransaction(async (tx) => {
    const parent = await probeDomain.create({ name: parentName }, tx);
    const nested = await withNestedTransaction(tx, (savepoint) => probeDomain.create({ name: nestedName }, savepoint));
    await withNestedTransaction(tx, async (savepoint) => {
      await probeDomain.create({ name: failedNestedName }, savepoint);
      throw new Error('savepoint probe');
    }).catch(() => undefined);
    // Neither hook may start while the outer transaction is still open
    await sleep(200);
    return [parent.id, nested.id];
  });
  await waitUntil(
    () => hookSawRow.has(parentName) && hookSawRow.has(nestedName),
    'afterCreate of the parent and the nested create',
  );
  await sleep(100);
  assertEquals(
    hookStarts.filter((name) => [parentName, nestedName, failedNestedName].includes(name)),
    [parentName, nestedName],
    'hooks start in scheduling order, without the rolled-back savepoint',
  );
  assertEquals(hookSawRow.get(parentName), true, 'the parent row is committed when its hook starts');
  assertEquals(hookSawRow.get(nestedName), true, 'the nested row is committed with the outer transaction');

  logStep('20.5 An after* hook on a transaction COG did not open fails loudly');
  const foreignName = probeName('foreign');
  const foreignError = await withoutTransaction()
    .transaction((tx) => probeDomain.create({ name: foreignName }, tx))
    .catch((error: unknown) => error);
  assert(
    foreignError instanceof Error && foreignError.message.includes('withTransaction()'),
    'scheduling on a foreign transaction must throw',
  );
  const foreignRows = await getSQL()`SELECT id FROM skill WHERE name = ${foreignName}`;
  assertEquals(foreignRows.length, 0, 'the refused create is rolled back with its transaction');

  logStep('20.6 A read without a transaction starts its after* hook right away');
  const readHookIds: string[] = [];
  const readDomain = new SkillDomain({
    afterFindById: (skill: Skill | null): Promise<void> => {
      if (skill) readHookIds.push(skill.id);
      return Promise.resolve();
    },
  });
  await readDomain.findById(committed.id);
  await waitUntil(() => readHookIds.includes(committed.id), 'afterFindById of a read without a transaction');

  for (const id of [committed.id, retried.id, ...nestedIds]) {
    await DELETE(`/api/skill/${id}`);
  }
  logSuccess('✓ after* hooks start after COMMIT; rollback, retry and a failed savepoint drop them');

  // ========================================
  // 21. JUNCTION HOOKS REGISTERED THROUGH initializeGenerated
  // ========================================
  logSection('21. Testing Junction Hooks Registered Through initializeGenerated');

  // src/main.ts passes skillListJunctionHooks inside domainHooks.employee; the hooks record their calls,
  // and the middleware sets someString on every request.
  logStep('21.1 Adding a skill over REST runs the add hooks with the request context');
  const junctionEmployee = await POST('/api/employee', {
    firstName: 'Junction',
    lastName: 'Probe',
    email: `junction.${crypto.randomUUID().slice(0, 8)}@example.com`,
    departmentId: createdIds.departments[0],
  }) as Employee;
  const junctionSkillId = createdIds.skills[0];
  hookCalls.length = 0;
  await POST(`/api/employee/${junctionEmployee.id}/skill`, { id: junctionSkillId });
  await waitUntil(() => hookCalls.some((call) => call.hook === 'skillList.afterAddJunction'), 'afterAddJunction');
  assertEquals(
    hookCalls.map((call) => call.hook),
    [
      'skillList.beforeAddJunction',
      'skillList.preAddJunction',
      'skillList.postAddJunction',
      'skillList.afterAddJunction',
    ],
    'the junction hooks from initializeGenerated must run, in lifecycle order',
  );
  assert(
    hookCalls.every((call) => typeof call.context?.someString === 'string'),
    'every junction hook must receive the request context',
  );

  logStep('21.2 Removing it runs the remove hooks');
  hookCalls.length = 0;
  const removedLink = await REQUEST('DELETE', `/api/employee/${junctionEmployee.id}/skill`, { id: junctionSkillId });
  assertEquals(removedLink.status, 200, 'removing the link succeeds');
  await waitUntil(() => hookCalls.some((call) => call.hook === 'skillList.afterRemoveJunction'), 'afterRemoveJunction');
  assertEquals(
    hookCalls.map((call) => call.hook),
    [
      'skillList.beforeRemoveJunction',
      'skillList.preRemoveJunction',
      'skillList.postRemoveJunction',
      'skillList.afterRemoveJunction',
    ],
    'the remove hooks must run, in lifecycle order',
  );

  await DELETE(`/api/employee/${junctionEmployee.id}`);
  logSuccess('✓ Junction hooks registered through initializeGenerated run, with the request context');

  // ========================================
  // 22. FILTER VALIDATION IN THE DOMAIN
  // ========================================
  logSection('22. Testing Filter Validation in the Domain');

  // The domain used to drop a condition it could not apply, so the filter matched every row.
  logStep('22.1 A filter on an unknown field is refused');
  const unknownField = await skillDomain.findMany(undefined, { where: { field: 'nope', op: 'eq', value: 1 } })
    .catch((error: unknown) => error);
  assert(unknownField instanceof InvalidFilterException, 'an unknown field must raise InvalidFilterException');

  logStep('22.2 A filter on a hidden field is refused');
  const hiddenField = await exposuretestentityDomain.findMany(undefined, {
    where: { field: 'hiddenField', op: 'eq', value: 'secret' },
  }).catch((error: unknown) => error);
  assert(hiddenField instanceof InvalidFilterException, 'a hidden field must raise InvalidFilterException');

  logStep('22.3 An operator the field type does not support is refused');
  const unsupportedOperator = await skillDomain.findMany(undefined, { where: { field: 'name', op: 'gt', value: 'a' } })
    .catch((error: unknown) => error);
  assert(
    unsupportedOperator instanceof InvalidFilterException,
    'gt on a string field must raise InvalidFilterException',
  );

  logStep('22.4 A SQL condition on a hidden column still works for server-side code');
  const hiddenValue = `hidden-${crypto.randomUUID()}`;
  const sqlProbe = await POST('/api/exposuretestentity', {
    normalField: 'SQL filter probe',
    hiddenField: hiddenValue,
  }) as ExposureTestEntity;
  const bySql = await exposuretestentityDomain.findMany(undefined, {
    where: eq(exposuretestentityTable.hiddenField, hiddenValue),
  });
  assertEquals(bySql.data.map((row) => row.id), [sqlProbe.id], 'the SQL condition selects exactly the probe row');
  await DELETE(`/api/exposuretestentity/${sqlProbe.id}`);
  logSuccess('✓ The domain refuses filters it cannot apply; SQL conditions reach hidden columns');

  // ========================================
  // SUCCESS
  // ========================================
  logSection('All Tests Passed!');
  console.log('\nSummary:');
  console.log(`  Departments created: ${createdIds.departments.length}`);
  console.log(`  Employees created: ${createdIds.employees.length}`);
  console.log(`  Skills created: ${createdIds.skills.length}`);
  console.log(`  Projects created: ${createdIds.projects.length}`);
  console.log(`  Assignments created: ${createdIds.assignments.length}`);
  console.log(`  ID Cards created: ${createdIds.idCards.length}`);
  console.log(`  Exposure Test Entities created: ${createdIds.exposureTestEntities.length}`);
  console.log(`  Acceptance Test Entities created: ${createdIds.acceptanceTestEntities.length}`);
  console.log(`  Soft Delete Test Entities created: ${createdIds.softDeleteTestEntities.length}`);
  console.log(`  Soft Delete Parents created: ${createdIds.softDeleteParents.length}`);
  console.log(`  Soft Delete Children created: ${createdIds.softDeleteChildren.length}`);
  console.log(`  Soft Delete Tags created: ${createdIds.softDeleteTags.length}`);
}

// ============================================================================
// Cleanup Helpers
// ============================================================================

async function safeDelete(path: string, description: string): Promise<boolean> {
  try {
    await DELETE(path);
    console.log(`  Deleted: ${description}`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      console.log(`  Not found (already deleted): ${description}`);
      return false;
    }
    console.error(`  Failed to delete: ${description}`);
    console.error(`    Error: ${error}`);
    return false;
  }
}

async function getAllIds(endpoint: string): Promise<string[]> {
  try {
    const response = await GET<{ data: Array<{ id: string }> }>(endpoint);
    return response.data.map((item) => item.id);
  } catch (error) {
    console.error(`  Failed to fetch ${endpoint}:`, error);
    return [];
  }
}

async function cleanupManyToMany(
  parentEndpoint: string,
  parentIds: string[],
  relationshipName: string,
  description: string,
): Promise<number> {
  let deletedCount = 0;

  for (const parentId of parentIds) {
    try {
      const related = await GET<{ data: Array<{ id: string }> }>(
        `${parentEndpoint}/${parentId}/${relationshipName}`,
      );

      if (related.data && related.data.length > 0) {
        const relatedIds = related.data.map((item) => item.id);
        await DELETE(`${parentEndpoint}/${parentId}/${relationshipName}?ids=${relatedIds.join(',')}`);
        deletedCount += relatedIds.length;
        console.log(`  Removed ${relatedIds.length} ${description} relationships`);
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('404'))) {
        console.log(`  Could not clean ${description} for ${parentId}`);
      }
    }
  }

  return deletedCount;
}

async function runCleanup(): Promise<number> {
  console.log('\nStarting Test Data Cleanup...\n');

  let totalDeleted = 0;

  // 1. GET ALL IDS
  logSection('1. Discovering Test Data');

  logStep('Finding all assignments');
  const assignmentIds = await getAllIds('/api/assignment');
  console.log(`  Found ${assignmentIds.length} assignments`);

  logStep('Finding all employees');
  const employeeIds = await getAllIds('/api/employee');
  console.log(`  Found ${employeeIds.length} employees`);

  logStep('Finding all ID cards');
  const idCardIds = await getAllIds('/api/idcard');
  console.log(`  Found ${idCardIds.length} ID cards`);

  logStep('Finding all skills');
  const skillIds = await getAllIds('/api/skill');
  console.log(`  Found ${skillIds.length} skills`);

  logStep('Finding all projects');
  const projectIds = await getAllIds('/api/project');
  console.log(`  Found ${projectIds.length} projects`);

  logStep('Finding all departments');
  const departmentIds = await getAllIds('/api/department');
  console.log(`  Found ${departmentIds.length} departments`);

  logStep('Finding all exposure test entities');
  const exposureTestEntityIds = await getAllIds('/api/exposuretestentity');
  console.log(`  Found ${exposureTestEntityIds.length} exposure test entities`);

  logStep('Finding all acceptance test entities');
  const acceptanceTestEntityIds = await getAllIds('/api/acceptancetestentity');
  console.log(`  Found ${acceptanceTestEntityIds.length} acceptance test entities`);

  // 2. DELETE JUNCTION TABLE RECORDS
  logSection('2. Cleaning Many-to-Many Relationships');

  logStep('Removing employee-skill relationships');
  const skillRelCount = await cleanupManyToMany('/api/employee', employeeIds, 'skillList', 'employee-skill');
  totalDeleted += skillRelCount;

  logStep('Removing employee-mentor relationships (mentees)');
  const menteeRelCount = await cleanupManyToMany('/api/employee', employeeIds, 'menteeList', 'mentor-mentee');
  totalDeleted += menteeRelCount;

  logStep('Removing employee-mentor relationships (mentors)');
  const mentorRelCount = await cleanupManyToMany('/api/employee', employeeIds, 'mentorList', 'mentor-mentee');
  totalDeleted += mentorRelCount;

  logSuccess('Junction tables cleaned');

  // 3. DELETE ASSIGNMENTS
  logSection('3. Deleting Assignments');
  for (const id of assignmentIds) {
    if (await safeDelete(`/api/assignment/${id}`, `assignment ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 4. DELETE ID CARDS
  logSection('4. Deleting ID Cards');
  for (const id of idCardIds) {
    if (await safeDelete(`/api/idcard/${id}`, `ID card ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 5. DELETE EMPLOYEES
  logSection('5. Deleting Employees');
  for (const id of employeeIds) {
    if (await safeDelete(`/api/employee/${id}`, `employee ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 6. DELETE SKILLS
  logSection('6. Deleting Skills');
  for (const id of skillIds) {
    if (await safeDelete(`/api/skill/${id}`, `skill ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 7. DELETE PROJECTS
  logSection('7. Deleting Projects');
  for (const id of projectIds) {
    if (await safeDelete(`/api/project/${id}`, `project ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 8. DELETE DEPARTMENTS
  logSection('8. Deleting Departments');
  for (const id of departmentIds) {
    if (await safeDelete(`/api/department/${id}`, `department ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 9. DELETE EXPOSURE TEST ENTITIES
  logSection('9. Deleting Exposure Test Entities');
  for (const id of exposureTestEntityIds) {
    if (await safeDelete(`/api/exposuretestentity/${id}`, `exposure test entity ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 10. DELETE ACCEPTANCE TEST ENTITIES
  logSection('10. Deleting Acceptance Test Entities');
  for (const id of acceptanceTestEntityIds) {
    if (await safeDelete(`/api/acceptancetestentity/${id}`, `acceptance test entity ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  // 11. DELETE SOFT DELETE TEST ENTITIES (children/tags before parents)
  logSection('11. Deleting Soft Delete Test Data');

  logStep('Deleting soft-delete children');
  for (const id of createdIds.softDeleteChildren) {
    if (await safeDelete(`/api/softdeletechild/${id}`, `soft-delete child ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  logStep('Deleting soft-delete tags');
  for (const id of createdIds.softDeleteTags) {
    if (await safeDelete(`/api/softdeletetag/${id}`, `soft-delete tag ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  logStep('Deleting soft-delete parents');
  for (const id of createdIds.softDeleteParents) {
    if (await safeDelete(`/api/softdeleteparent/${id}`, `soft-delete parent ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  logStep('Deleting soft-delete test entities');
  for (const id of createdIds.softDeleteTestEntities) {
    if (await safeDelete(`/api/softdeletetestentity/${id}`, `soft-delete test entity ${id.slice(0, 8)}`)) {
      totalDeleted++;
    }
  }

  logSection('Cleanup Complete!');
  console.log(`\nSummary: Deleted ${totalDeleted} records\n`);

  return totalDeleted;
}

// ============================================================================
// Test Harness
// ============================================================================

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/employee?limit=1`);
      if (response.ok) {
        console.log('Server is ready!');
        return;
      }
    } catch {
      // Server not ready yet, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

Deno.test({
  name: 'integration - full API test suite',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let serverHandle: ServerHandle | null = null;

    try {
      console.log('Starting example server...');
      serverHandle = await startServer({ port: 3000 });

      await waitForServer(BASE_URL, SERVER_STARTUP_TIMEOUT_MS);

      console.log('\n--- Running Integration Tests ---\n');
      await runTests();

      console.log('\n--- Cleaning Up Test Data ---\n');
      await runCleanup();

      console.log('\n--- Integration Tests Complete ---\n');
    } finally {
      if (serverHandle) {
        console.log('Shutting down server...');
        await serverHandle.shutdown();
      }
    }
  },
});
