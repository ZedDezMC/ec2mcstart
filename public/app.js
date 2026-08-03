document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const ec2StatusBadge = document.getElementById('ec2-status');
  const mcStatusBadge = document.getElementById('mc-status');
  const ipContainer = document.getElementById('ip-container');
  const serverIpEl = document.getElementById('server-ip');
  const btnCopyIp = document.getElementById('btn-copy-ip');
  const copyTextEl = document.getElementById('copy-text');
  const btnRefresh = document.getElementById('btn-refresh');

  // Action Sections
  const sectionStartEc2 = document.getElementById('section-start-ec2');
  const sectionStarting = document.getElementById('section-starting');
  const sectionRequestMc = document.getElementById('section-request-mc');
  const sectionWaitingApproval = document.getElementById('section-waiting-approval');
  const sectionOnline = document.getElementById('section-online');
  const captchaWrapper = document.getElementById('captcha-container');

  // Buttons
  const btnStartEc2 = document.getElementById('btn-start-ec2');
  const btnRequestMc = document.getElementById('btn-request-mc');
  const countdownTimerEl = document.getElementById('countdown-timer');
  const progressBarEl = document.getElementById('progress-bar');
  const toastEl = document.getElementById('toast-message');

  // State Variables
  let currentCaptchaToken = null;
  let pollInterval = null;
  let countdownInterval = null;
  let turnstileWidgetId = null;
  let turnstileSiteKey = '';
  let isWaitingApproval = false;

  // Initial Fetch
  fetchStatus();

  // Polling status every 6 seconds
  pollInterval = setInterval(() => {
    if (!isWaitingApproval) {
      fetchStatus(true);
    }
  }, 6000);

  // Refresh Button
  btnRefresh.addEventListener('click', () => {
    fetchStatus();
    showToast('Đang cập nhật trạng thái...');
  });

  // Copy Address Button
  btnCopyIp.addEventListener('click', () => {
    const ipText = serverIpEl.textContent;
    navigator.clipboard.writeText(ipText).then(() => {
      copyTextEl.textContent = 'Đã sao chép!';
      setTimeout(() => copyTextEl.textContent = 'Sao chép', 2000);
    });
  });

  // Start EC2 Button Click
  btnStartEc2.addEventListener('click', async () => {
    if (!currentCaptchaToken && turnstileSiteKey) {
      showToast('Vui lòng hoàn thành Captcha trước!');
      return;
    }

    showSection(sectionStarting);
    animateProgressBar();

    try {
      const res = await fetch('/api/start-ec2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captchaToken: currentCaptchaToken })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Khởi động thất bại');
      }

      showToast('🚀 ' + (data.message || 'Đang khởi động VPS EC2...'));
      fetchStatus();

    } catch (err) {
      showToast('❌ ' + err.message);
      showSection(sectionStartEc2);
      resetCaptcha();
    }
  });

  // Request Minecraft Start Button Click
  btnRequestMc.addEventListener('click', async () => {
    isWaitingApproval = true;
    showSection(sectionWaitingApproval);
    start10MinCountdown();

    try {
      const res = await fetch('/api/request-mc-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await res.json();
      stop10MinCountdown();
      isWaitingApproval = false;

      if (res.ok && data.status === 'approved') {
        showToast('🎉 Admin đã duyệt! Đang bật Minecraft Server...');
        showSection(sectionStarting);
        document.getElementById('starting-title').textContent = 'Đang Bật Minecraft Server qua AWS SSM...';
        setTimeout(() => fetchStatus(), 5000);
      } else {
        throw new Error(data.error || 'Yêu cầu bị từ chối hoặc hết hạn.');
      }
    } catch (err) {
      stop10MinCountdown();
      isWaitingApproval = false;
      showToast('❌ ' + err.message);
      fetchStatus();
    }
  });

  /**
   * Fetch System Status from API
   */
  async function fetchStatus(isBackground = false) {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;

      const data = await res.json();
      turnstileSiteKey = data.turnstileSiteKey;

      // Update EC2 Badge
      updateBadge(ec2StatusBadge, data.ec2State);

      // Update Minecraft Badge
      if (data.ec2State === 'running') {
        updateBadge(mcStatusBadge, data.mcOnline ? 'online' : 'offline');
      } else {
        updateBadge(mcStatusBadge, 'offline');
      }

      // Update Server Address Display
      if (data.serverAddress && (data.ec2State === 'running' || data.ec2State === 'pending')) {
        ipContainer.classList.remove('hidden');
        serverIpEl.textContent = data.serverAddress;
      } else {
        ipContainer.classList.add('hidden');
      }

      // Don't override UI section if user is waiting for Discord approval
      if (isWaitingApproval) return;

      // Determine UI Section
      if (data.ec2State === 'stopped') {
        showSection(sectionStartEc2);
        initTurnstile(data.turnstileSiteKey);
      } else if (data.ec2State === 'pending') {
        showSection(sectionStarting);
        animateProgressBar();
      } else if (data.ec2State === 'running') {
        if (data.mcOnline) {
          showSection(sectionOnline);
        } else {
          showSection(sectionRequestMc);
        }
      }
    } catch (err) {
      if (!isBackground) console.error('Error fetching status:', err);
    }
  }

  /**
   * Update Badge Style & Text
   */
  function updateBadge(el, state) {
    el.className = 'badge';
    const textEl = el.querySelector('.text');

    if (state === 'running' || state === 'online') {
      el.classList.add('badge-online');
      textEl.textContent = state === 'running' ? 'Đang Chạy (Running)' : 'Online (Sẵn sàng)';
    } else if (state === 'pending') {
      el.classList.add('badge-warning');
      textEl.textContent = 'Đang Khởi Động...';
    } else {
      el.classList.add('badge-offline');
      textEl.textContent = state === 'stopped' ? 'Đã Tắt (Stopped)' : 'Offline';
    }
  }

  /**
   * Section Switcher Helper
   */
  function showSection(activeSection) {
    [sectionStartEc2, sectionStarting, sectionRequestMc, sectionWaitingApproval, sectionOnline].forEach(sec => {
      sec.classList.add('hidden');
    });
    activeSection.classList.remove('hidden');
  }

  /**
   * Cloudflare Turnstile Captcha Handler
   */
  function initTurnstile(siteKey) {
    if (!siteKey || siteKey.includes('XXXXX')) {
      // If sitekey is missing, enable button directly
      btnStartEc2.disabled = false;
      return;
    }

    if (window.turnstile && captchaWrapper.children.length === 0) {
      turnstileWidgetId = window.turnstile.render('#captcha-container', {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token) => {
          currentCaptchaToken = token;
          btnStartEc2.disabled = false;
        },
        'expired-callback': () => {
          currentCaptchaToken = null;
          btnStartEc2.disabled = true;
        }
      });
    }
  }

  function resetCaptcha() {
    currentCaptchaToken = null;
    btnStartEc2.disabled = true;
    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  }

  /**
   * Progress Bar Animation Simulation
   */
  function animateProgressBar() {
    let progress = 10;
    progressBarEl.style.width = '10%';
    const interval = setInterval(() => {
      if (progress < 90) {
        progress += Math.floor(Math.random() * 8) + 2;
        progressBarEl.style.width = `${progress}%`;
      } else {
        clearInterval(interval);
      }
    }, 1500);
  }

  /**
   * 10-Minute Countdown Timer for Discord Approval
   */
  function start10MinCountdown() {
    let durationSeconds = 10 * 60; // 600 seconds
    updateTimerText(durationSeconds);

    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      durationSeconds--;
      if (durationSeconds <= 0) {
        clearInterval(countdownInterval);
        countdownTimerEl.textContent = '00:00 (Hết hạn)';
      } else {
        updateTimerText(durationSeconds);
      }
    }, 1000);
  }

  function stop10MinCountdown() {
    clearInterval(countdownInterval);
  }

  function updateTimerText(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    countdownTimerEl.textContent = `${m}:${s}`;
  }

  /**
   * Toast notification display
   */
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 4000);
  }
});
