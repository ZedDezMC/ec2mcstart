document.addEventListener('DOMContentLoaded', () => {
  // Status Elements
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

  // Action Buttons
  const btnStartEc2 = document.getElementById('btn-start-ec2');
  const btnRequestMc = document.getElementById('btn-request-mc');
  const countdownTimerEl = document.getElementById('countdown-timer');
  const progressBarEl = document.getElementById('progress-bar');
  const toastEl = document.getElementById('toast-message');

  // Background & Blur Settings Elements
  const bgCustomLayer = document.getElementById('bg-custom-layer');
  const bgOverlayLayer = document.getElementById('bg-overlay-layer');
  const btnOpenBlurSettings = document.getElementById('btn-open-blur-settings');
  const btnCloseBlur = document.getElementById('btn-close-blur');
  const blurModal = document.getElementById('blur-modal');
  const sliderBlur = document.getElementById('slider-blur');
  const blurValText = document.getElementById('blur-val-text');
  const sliderOverlay = document.getElementById('slider-overlay');
  const overlayValText = document.getElementById('overlay-val-text');
  const btnResetBlur = document.getElementById('btn-reset-blur');

  // State Variables
  let currentCaptchaToken = null;
  let pollInterval = null;
  let countdownInterval = null;
  let turnstileWidgetId = null;
  let turnstileSiteKey = '';
  let isWaitingApproval = false;

  // 5-Minute Lock State Variables
  let lock5MinInterval = null;
  const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 phút = 300,000 ms

  const requestMcDesc = document.getElementById('request-mc-desc');
  const btnRequestMcIcon = document.getElementById('btn-request-mc-icon');
  const btnRequestMcText = document.getElementById('btn-request-mc-text');

  // ----------------------------------------------------
  // BACKGROUND BLUR & OVERLAY CONTROL LOGIC
  // ----------------------------------------------------
  initBlurSettings();

  function initBlurSettings() {
    const savedBlur = localStorage.getItem('user_bg_blur') || '6';
    const savedOverlay = localStorage.getItem('user_bg_overlay') || '55';

    applyBlur(savedBlur);
    applyOverlay(savedOverlay);

    // Open Modal
    btnOpenBlurSettings.addEventListener('click', () => {
      blurModal.classList.remove('hidden');
    });

    // Close Modal
    btnCloseBlur.addEventListener('click', () => {
      blurModal.classList.add('hidden');
    });

    blurModal.addEventListener('click', (e) => {
      if (e.target === blurModal) {
        blurModal.classList.add('hidden');
      }
    });

    // Blur Slider Change
    sliderBlur.addEventListener('input', (e) => {
      const val = e.target.value;
      applyBlur(val);
      localStorage.setItem('user_bg_blur', val);
    });

    // Overlay Slider Change
    sliderOverlay.addEventListener('input', (e) => {
      const val = e.target.value;
      applyOverlay(val);
      localStorage.setItem('user_bg_overlay', val);
    });

    // Reset Button
    btnResetBlur.addEventListener('click', () => {
      applyBlur('6');
      applyOverlay('55');
      localStorage.removeItem('user_bg_blur');
      localStorage.removeItem('user_bg_overlay');
      showToast('Đã khôi phục cài đặt độ mờ mặc định!');
    });
  }

  function applyBlur(pxVal) {
    if (bgCustomLayer) {
      bgCustomLayer.style.filter = `blur(${pxVal}px)`;
    }
    if (blurValText) {
      blurValText.textContent = `${pxVal}px`;
    }
    if (sliderBlur) {
      sliderBlur.value = pxVal;
    }
  }

  function applyOverlay(opacityPercent) {
    const opacityDec = parseInt(opacityPercent, 10) / 100;
    if (bgOverlayLayer) {
      bgOverlayLayer.style.background = `rgba(15, 23, 42, ${opacityDec})`;
    }
    if (overlayValText) {
      overlayValText.textContent = `${opacityPercent}%`;
    }
    if (sliderOverlay) {
      sliderOverlay.value = opacityPercent;
    }
  }

  // ----------------------------------------------------
  // SYSTEM STATUS & ACTIONS LOGIC
  // ----------------------------------------------------

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

      // Lưu mốc thời gian bắt đầu bật VPS vào localStorage để khóa nút 5 phút
      localStorage.setItem('vps_start_time', Date.now().toString());

      showToast('[INFO] ' + (data.message || 'Đang khởi động VPS EC2...'));
      fetchStatus();

    } catch (err) {
      showToast('[ERROR] ' + err.message);
      showSection(sectionStartEc2);
      resetCaptcha();
    }
  });

  // Request Minecraft Start Button Click
  btnRequestMc.addEventListener('click', async () => {
    if (btnRequestMc.disabled) return;

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
        showToast('[SUCCESS] Admin đã duyệt! Đang bật Minecraft Server...');
        showSection(sectionStarting);
        document.getElementById('starting-title').textContent = 'Đang Bật Minecraft Server qua AWS SSM...';
        setTimeout(() => fetchStatus(), 5000);
      } else {
        throw new Error(data.error || 'Yêu cầu bị từ chối hoặc hết hạn.');
      }
    } catch (err) {
      stop10MinCountdown();
      isWaitingApproval = false;
      showToast('[ERROR] ' + err.message);
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
        clear5MinLock();
        showSection(sectionStartEc2);
        initTurnstile(data.turnstileSiteKey);
      } else if (data.ec2State === 'pending') {
        showSection(sectionStarting);
        animateProgressBar();
      } else if (data.ec2State === 'running') {
        if (data.mcOnline) {
          clear5MinLock();
          showSection(sectionOnline);
        } else {
          showSection(sectionRequestMc);
          checkAndApply5MinLock();
        }
      }
    } catch (err) {
      if (!isBackground) console.error('Error fetching status:', err);
    }
  }

  /**
   * Kiểm tra & Áp dụng khóa nút 5 phút nếu VPS vừa được bấm bật
   */
  function checkAndApply5MinLock() {
    const startTimeStr = localStorage.getItem('vps_start_time');
    if (!startTimeStr) {
      unlockRequestMcButton();
      return;
    }

    const startTime = parseInt(startTimeStr, 10);
    const elapsed = Date.now() - startTime;
    const remainingMs = LOCK_DURATION_MS - elapsed;

    if (remainingMs <= 0) {
      clear5MinLock();
      unlockRequestMcButton();
      return;
    }

    // Đang trong thời gian 5 phút khóa
    lockRequestMcButton(remainingMs);
  }

  function lockRequestMcButton(remainingMs) {
    btnRequestMc.disabled = true;
    if (btnRequestMcIcon) btnRequestMcIcon.textContent = '[LOCKED]';

    updateLockTimerText(remainingMs);

    clearInterval(lock5MinInterval);
    lock5MinInterval = setInterval(() => {
      const startTime = parseInt(localStorage.getItem('vps_start_time') || '0', 10);
      const rem = LOCK_DURATION_MS - (Date.now() - startTime);

      if (rem <= 0) {
        clear5MinLock();
        unlockRequestMcButton();
        showToast('[INFO] Nếu server chưa tự bật, bạn có thể gửi yêu cầu cho Admin.');
      } else {
        updateLockTimerText(rem);
      }
    }, 1000);
  }

  function updateLockTimerText(remMs) {
    const sec = Math.ceil(remMs / 1000);
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');

    if (btnRequestMcText) {
      btnRequestMcText.textContent = `Tự Động Bật (Khóa Nút Trong ${m}:${s})`;
    }
    if (requestMcDesc) {
      requestMcDesc.textContent = `VPS vừa bật. Vui lòng chờ server tự khởi động (khóa nút ${m}:${s}). Nếu sau 5 phút server chưa tự chạy, nút sẽ mở để bạn gửi thông báo cho Admin.`;
    }
  }

  function unlockRequestMcButton() {
    clearInterval(lock5MinInterval);
    btnRequestMc.disabled = false;
    if (btnRequestMcIcon) btnRequestMcIcon.textContent = '💬';
    if (btnRequestMcText) btnRequestMcText.textContent = 'Gửi Yêu Cầu Bật Minecraft (Qua Discord)';
    if (requestMcDesc) {
      requestMcDesc.textContent = 'Vui lòng chờ server tự khởi động hoặc bấm nút bên dưới để gửi thông báo đến Discord của Admin phê duyệt bật Minecraft Server.';
    }
  }

  function clear5MinLock() {
    clearInterval(lock5MinInterval);
    lock5MinInterval = null;
    localStorage.removeItem('vps_start_time');
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
