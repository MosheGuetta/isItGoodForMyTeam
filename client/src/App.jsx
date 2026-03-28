import { useEffect, useState } from 'react';
import { initLegacyApp } from './legacy/app-runtime';

export default function App() {
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    initLegacyApp();
  }, []);

  return (
    <>
      <div className="app-header">
        <div className="app-title-row">
          <span className="app-ball">🏀</span>
          <div>
            <div className="app-title">Is It Good For My Team?</div>
            <div className="app-subtitle" id="appSubtitle">
              EuroLeague 2025-26
            </div>
          </div>
        </div>
        <div className="header-status" id="headerStatus" />
      </div>

      <main className="app-shell">
        <section className="screen active" id="screen-auth">
          <div className="auth-screen">
            <div className="auth-hero">
              <div className="auth-kicker">Mobile-first onboarding</div>
              <h1>Start with your account.</h1>
              <p>
                Use one clean login/register screen in mobile and web, then
                continue into your team setup.
              </p>
            </div>
            <div className="auth-card">
              <div className="auth-toggle">
                <button
                  className="auth-mode-btn active"
                  id="loginModeBtn"
                  onClick={() => window.setAuthMode?.('login')}
                >
                  Log In
                </button>
                <button
                  className="auth-mode-btn"
                  id="registerModeBtn"
                  onClick={() => window.setAuthMode?.('register')}
                >
                  Register
                </button>
              </div>
              <div className="auth-fields">
                <label className="field-label" htmlFor="authName">
                  Name
                </label>
                <input
                  className="app-input"
                  id="authName"
                  type="text"
                  placeholder="Moshe"
                />
              </div>
              <div className="auth-fields">
                <label className="field-label" htmlFor="authEmail">
                  Email
                </label>
                <input
                  className="app-input"
                  id="authEmail"
                  type="email"
                  placeholder="you@example.com"
                />
              </div>
              <div className="auth-fields">
                <label className="field-label" htmlFor="authPassword">
                  Password
                </label>
                <div className="password-wrapper">
                  <input
                    className="app-input"
                    id="authPassword"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    className="password-eye-btn"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <div className="forgot-row" id="forgotRow">
                <button
                  type="button"
                  className="forgot-link"
                  onClick={() => window.openForgotPassword?.()}
                >
                  Forgot password?
                </button>
              </div>
              <p className="auth-note" id="authModeCopy">
                Welcome back. Log in to keep your saved team context across
                devices later.
              </p>
              <div className="auth-error" id="authError" />
              <button
                className="primary-btn auth-submit"
                onClick={() => window.submitAuth?.()}
              >
                <span id="authSubmitLabel">Continue</span>
              </button>
            </div>
          </div>
        </section>

        <section className="screen" id="screen-setup">
          <div className="setup-shell">
            <div className="setup-intro">
              <div className="auth-kicker">Step 2 of 2</div>
              <h2>Choose your team and goal.</h2>
              <p>
                Your selection shapes the analysis, standings highlights,
                schedule emphasis, and player context.
              </p>
            </div>
            <div className="panel">
              <div className="section-title highlight-title">
                Choose Your Team
              </div>
              <div className="team-grid" id="teamGrid" />
            </div>
            <div className="panel goal-section">
              <div className="section-title highlight-title">
                Choose Your Goal
              </div>
              <div className="goal-btns">
                <button
                  className="goal-btn playoffs"
                  onClick={() => window.selectGoal?.('playoffs')}
                >
                  Playoffs
                  <br />
                  <small>Top 6</small>
                </button>
                <button
                  className="goal-btn playin"
                  onClick={() => window.selectGoal?.('playin')}
                >
                  Play-In
                  <br />
                  <small>Top 10</small>
                </button>
              </div>
            </div>
            <button
              className="primary-btn"
              onClick={() => window.completeSetup?.()}
            >
              Enter App
            </button>
          </div>
        </section>

        <section className="screen" id="screen-app">
          <div className="tabs">
            <button
              className="tab-btn active"
              onClick={() => window.switchTab?.('analysis')}
            >
              📊 Analysis
            </button>
            <button
              className="tab-btn"
              onClick={() => window.switchTab?.('standings')}
            >
              🏆 Standings
            </button>
            <button
              className="tab-btn"
              onClick={() => window.switchTab?.('schedule')}
            >
              🗓️ Schedule
            </button>
            <button
              className="tab-btn"
              onClick={() => window.switchTab?.('players')}
            >
              👥 Players
            </button>
            <button
              className="tab-btn"
              onClick={() => window.switchTab?.('live')}
            >
              ⚡ Live
            </button>
            <button
              className="tab-btn"
              onClick={() => window.switchTab?.('scenarios')}
            >
              Scenarios
            </button>
          </div>
          <div id="tab-analysis" className="tab-content active">
            <div className="analysis-toolbar">
              <div id="analysisSummary" />
              <div className="analysis-actions">
                <button
                  className="secondary-btn"
                  id="logoutBtn"
                  onClick={() => window.logout?.()}
                >
                  Log Out
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => window.goToSetup?.()}
                >
                  Change Team / Goal
                </button>
                <button
                  className="primary-btn compact-btn"
                  onClick={() => window.runAnalysis?.()}
                >
                  Refresh Analysis
                </button>
              </div>
            </div>
            <div id="analysis-result" />
          </div>
          <div id="tab-standings" className="tab-content">
            <div id="standings-content" />
          </div>
          <div id="tab-schedule" className="tab-content">
            <div id="schedule-content" />
          </div>
          <div id="tab-players" className="tab-content">
            <div id="players-content" />
          </div>
          <div id="tab-live" className="tab-content">
            <div id="live-results-content" />
          </div>
          <div id="tab-scenarios" className="tab-content">
            <div id="scenarios-content" />
          </div>
        </section>
      </main>
      {/* Forgot Password Modal */}
      <div className="result-alert-modal" id="forgotPasswordModal" aria-hidden="true">
        <div
          className="result-alert-backdrop"
          onClick={() => window.closeForgotPassword?.()}
        />
        <div
          className="result-alert-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="forgotPasswordTitle"
        >
          <div className="result-alert-kicker">Account recovery</div>
          <div className="result-alert-title" id="forgotPasswordTitle">Reset your password</div>
          <p className="forgot-modal-desc">Enter your email and we'll send you a reset link.</p>
          <div className="auth-fields" style={{marginTop: '14px'}}>
            <label className="field-label" htmlFor="forgotEmail">Email</label>
            <input
              className="app-input"
              id="forgotEmail"
              type="email"
              placeholder="you@example.com"
            />
          </div>
          <div className="auth-error" id="forgotError" />
          <div className="auth-success" id="forgotSuccess" />
          <button
            className="primary-btn result-alert-btn"
            id="forgotSubmitBtn"
            onClick={() => window.submitForgotPassword?.()}
          >
            <span id="forgotSubmitLabel">Send Reset Link</span>
          </button>
          <button
            type="button"
            className="forgot-cancel-btn"
            onClick={() => window.closeForgotPassword?.()}
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="result-alert-modal" id="resultAlertModal" aria-hidden="true">
        <div
          className="result-alert-backdrop"
          onClick={() => window.closeResultAlert?.()}
        />
        <div
          className="result-alert-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resultAlertTitle"
        >
          <div className="result-alert-kicker">Round update</div>
          <div className="result-alert-title" id="resultAlertTitle" />
          <div className="result-alert-body" id="resultAlertBody" />
          <button
            className="primary-btn result-alert-btn"
            onClick={() => window.closeResultAlert?.()}
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}
