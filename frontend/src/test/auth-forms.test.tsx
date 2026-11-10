import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../pages/auth/LoginPage';
import { RegisterPage } from '../pages/auth/RegisterPage';
import { AuthProvider } from '../context/AuthContext';

describe('Auth Pages Form Validation', () => {
  it('renders LoginPage with email, password fields and submission CTA', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: /sign in to gstflow/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders RegisterPage with checklist and password inputs', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <RegisterPage />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: /create your gstflow account/i })).toBeInTheDocument();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 1 uppercase letter/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 1 number/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });
});
