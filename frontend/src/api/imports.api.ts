import { apiClient } from './client';
import {
  ImportBatchItem,
  ImportBatchStatus,
  ImportBatchStatusResponse,
  ImportSummaryResponse,
  Pagination
} from './types';

export interface ListImportsParams {
  page?: number;
  limit?: number;
  status?: ImportBatchStatus;
  gstRegistrationId?: string;
  sourcePlatform?: string;
  startDate?: string;
  endDate?: string;
}

export interface UploadImportPayload {
  file: File;
  gstRegistrationId: string;
  sourcePlatform?: 'AMAZON' | 'FLIPKART' | 'MEESHO' | 'CUSTOM';
  metadata?: Record<string, any>;
}

export interface UploadImportResponse {
  batchId: string;
  batchNumber: string;
  status: ImportBatchStatus;
  organizationId: string;
  gstRegistrationId: string;
  sourcePlatform: string;
  file: {
    filename: string;
    fileSizeBytes: string;
    fileHash: string;
  };
  job?: {
    id: string;
    status: string;
    checkpoint: string;
  };
  createdAt: string;
}

export const importsApi = {
  async upload(organizationId: string, payload: UploadImportPayload): Promise<UploadImportResponse> {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('gstRegistrationId', payload.gstRegistrationId);
    if (payload.sourcePlatform) {
      formData.append('sourcePlatform', payload.sourcePlatform);
    }
    if (payload.metadata) {
      formData.append('metadata', JSON.stringify(payload.metadata));
    }

    return apiClient<UploadImportResponse>(`/organizations/${organizationId}/imports`, {
      method: 'POST',
      body: formData
    });
  },

  async list(
    organizationId: string,
    params?: ListImportsParams
  ): Promise<{ items: ImportBatchItem[]; pagination: Pagination }> {
    return apiClient<{ items: ImportBatchItem[]; pagination: Pagination }>(
      `/organizations/${organizationId}/imports`,
      { params: params as any }
    );
  },

  async getBatch(organizationId: string, batchId: string): Promise<ImportBatchItem> {
    return apiClient<ImportBatchItem>(`/organizations/${organizationId}/imports/${batchId}`);
  },

  async getStatus(organizationId: string, batchId: string): Promise<ImportBatchStatusResponse> {
    return apiClient<ImportBatchStatusResponse>(
      `/organizations/${organizationId}/imports/${batchId}/status`
    );
  },

  async getSummary(organizationId: string, batchId: string): Promise<ImportSummaryResponse> {
    return apiClient<ImportSummaryResponse>(
      `/organizations/${organizationId}/imports/${batchId}/summary`
    );
  }
};
