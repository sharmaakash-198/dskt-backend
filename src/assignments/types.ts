export class AssignmentError extends Error {
  constructor(
    public readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'employee_not_found'
      | 'employee_inactive'
      | 'space_not_found'
      | 'space_not_assignable'
      | 'revision_not_published'
      | 'location_archived'
      | 'invalid_assignment_period'
      | 'space_already_assigned'
      | 'command_id_payload_mismatch'
      | 'assignment_not_found'
      | 'assignment_already_ended',
    message?: string,
  ) {
    super(message || code);
    this.name = 'AssignmentError';
  }
}

export type AssignmentStatus = 'CURRENT' | 'FUTURE' | 'ENDED';

export type CreateAssignmentInput = {
  employeeId: string;
  placementIdentityId: string;
  startedAt: string;
  endedAt?: string | null;
  clientCommandId?: string | null;
  actorUserId: string;
};

export type EndAssignmentInput = {
  assignmentId: string;
  endedAt?: string | null;
  clientCommandId?: string | null;
  actorUserId: string;
};

export type AssignmentView = {
  id: string;
  placementIdentityId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeEmail?: string | null;
  departmentName?: string | null;
  spaceLabel?: string | null;
  floorId: string;
  floorName: string;
  buildingId?: string;
  buildingName: string;
  siteId?: string;
  siteName: string;
  startedAt: string;
  endedAt: string | null;
  status: AssignmentStatus;
  isAccessible?: boolean;
  assignedByUserId?: string;
  endedByUserId?: string | null;
  clientCommandId?: string | null;
  createdAt: string;
};

export type QueryAssignmentsFilter = {
  employeeId?: string;
  placementIdentityId?: string;
  floorId?: string;
  status?: AssignmentStatus | 'ALL';
};

export type QueryAssignmentHistoryFilter = {
  employeeId?: string;
  placementIdentityId?: string;
  floorId?: string;
  limit?: number;
  offset?: number;
};

export type PaginatedAssignmentHistory = {
  total: number;
  limit: number;
  offset: number;
  items: AssignmentView[];
};
