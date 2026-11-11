// TapVRM — tap your MacBook, your VRM avatar reacts.
//
// One binary, two roles:
//
//	tapvrm            (normal user) serves the web page on 127.0.0.1 and asks
//	                  macOS for permission to start the sensor helper.
//	tapvrm sensor     (root, started by the server) reads the Apple Silicon
//	                  accelerometer / lid-angle sensor and streams JSON lines
//	                  to the server over a private unix socket.
//
// The web server never runs as root; the root helper exits as soon as the
// server goes away.
package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/taigrr/apple-silicon-accelerometer/detector"
	"github.com/taigrr/apple-silicon-accelerometer/sensor"
	"github.com/taigrr/apple-silicon-accelerometer/shm"
)

//go:embed web
var webFS embed.FS

func main() {
	if len(os.Args) > 1 && os.Args[1] == "sensor" {
		if err := runSensor(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "tapvrm sensor:", err)
			os.Exit(1)
		}
		return
	}
	if err := runServer(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "tapvrm:", err)
		os.Exit(1)
	}
}

// ───────────────────────────── sensor (root) ─────────────────────────────

func runSensor(args []string) error {
	fl := flag.NewFlagSet("sensor", flag.ContinueOnError)
	sock := fl.String("socket", "", "unix socket of the TapVRM server")
	parent := fl.Int("parent", 0, "server pid; exit when it disappears")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *sock == "" {
		return errors.New("--socket is required")
	}
	conn, err := net.Dial("unix", *sock)
	if err != nil {
		return fmt.Errorf("connect server: %w", err)
	}
	defer conn.Close()
	out := json.NewEncoder(conn)
	var outMu sync.Mutex
	send := func(v any) error {
		outMu.Lock()
		defer outMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		return out.Encode(v)
	}

	if os.Geteuid() != 0 {
		send(map[string]any{"t": "error", "msg": "感測器程式沒有 root 權限"})
		return errors.New("needs root")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()

	// Server closed the socket → quit.
	go func() {
		buf := make([]byte, 64)
		for {
			if _, err := conn.Read(buf); err != nil {
				cancel()
				return
			}
		}
	}()
	// Server process vanished (e.g. killed) → quit.
	if *parent > 0 {
		go func() {
			for ctx.Err() == nil {
				if err := syscall.Kill(*parent, 0); errors.Is(err, syscall.ESRCH) {
					cancel()
					return
				}
				time.Sleep(time.Second)
			}
		}()
	}

	accel, err := shm.CreateRing("tapvrm_accel")
	if err != nil {
		send(map[string]any{"t": "error", "msg": "建立共享記憶體失敗：" + err.Error()})
		return err
	}
	defer accel.Unlink()
	defer accel.Close()
	lid, err := shm.CreateSnapshot("tapvrm_lid", shm.LidSize)
	if err == nil {
		defer lid.Unlink()
		defer lid.Close()
	} else {
		lid = nil
	}

	sensorErr := make(chan error, 1)
	go func() {
		cfg := sensor.Config{AccelRing: accel}
		if lid != nil {
			cfg.LidSnap = lid
		}
		sensorErr <- sensor.Run(cfg)
	}()

	send(map[string]any{"t": "hello", "pid": os.Getpid()})

	det := detector.New()
	var lastTotal uint64
	var lastLid uint32
	lidAngle := math.NaN()
	var grav [3]float64
	gravReady := false
	var hpPrevRaw, hpPrev [3]float64
	hpReady := false
	var peak float64
	var peakVec [3]float64
	var tapVec [3]float64
	var tapVecAt time.Time
	var lastEvent time.Time
	var lastTapSent time.Time
	tapCount := 0
	gotData := false
	start := time.Now()

	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	frameEvery := 33 * time.Millisecond
	nextFrame := time.Now()

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-sensorErr:
			send(map[string]any{"t": "error", "msg": "感測器停止：" + fmt.Sprint(err)})
			return err
		case <-tick.C:
		}

		now := time.Now()
		tNow := float64(now.UnixNano()) / 1e9
		samples, total := accel.ReadNew(lastTotal, shm.AccelScale)
		lastTotal = total
		if len(samples) > 400 {
			samples = samples[len(samples)-400:]
		}
		n := len(samples)
		if n > 0 && !gotData {
			gotData = true
			send(map[string]any{"t": "live"})
		}
		for i, s := range samples {
			ts := tNow - float64(n-i-1)/float64(det.FS)
			det.Process(s.X, s.Y, s.Z, ts)

			// Slow low-pass for gravity (tilt), fast high-pass for impacts.
			if !gravReady {
				grav = [3]float64{s.X, s.Y, s.Z}
				gravReady = true
			}
			for k, v := range [3]float64{s.X, s.Y, s.Z} {
				grav[k] += (v - grav[k]) * 0.02
			}
			raw := [3]float64{s.X, s.Y, s.Z}
			if !hpReady {
				hpPrevRaw, hpReady = raw, true
			}
			for k := range 3 {
				hpPrev[k] = 0.95 * (hpPrev[k] + raw[k] - hpPrevRaw[k])
			}
			hpPrevRaw = raw
			m := math.Sqrt(hpPrev[0]*hpPrev[0] + hpPrev[1]*hpPrev[1] + hpPrev[2]*hpPrev[2])
			if m > peak {
				peak, peakVec = m, hpPrev
			}
			if m > vecLen(tapVec) || now.Sub(tapVecAt) > 150*time.Millisecond {
				tapVec, tapVecAt = hpPrev, now
			}
		}

		if lid != nil {
			if a, c, changed := lid.ReadFloat32(lastLid); changed {
				lastLid = c
				lidAngle = float64(a)
			}
		}

		if len(det.Events) > 0 {
			ev := det.Events[len(det.Events)-1]
			if !ev.Time.Equal(lastEvent) {
				lastEvent = ev.Time
				// The detector can fire several times for one physical tap.
				if now.Sub(lastTapSent) > 180*time.Millisecond {
					lastTapSent = now
					tapCount++
					if err := send(map[string]any{
						"t": "tap", "n": tapCount, "amp": round(ev.Amplitude, 5),
						"sev": ev.Severity, "dir": round3(tapVec),
					}); err != nil {
						return nil
					}
				}
			}
			if len(det.Events) > 256 {
				det.Events = det.Events[len(det.Events)-32:]
			}
		}

		if now.After(nextFrame) {
			nextFrame = now.Add(frameEvery)
			if !gotData && now.Sub(start) > 4*time.Second {
				send(map[string]any{"t": "error", "msg": "4 秒內沒有收到加速度資料，這台 Mac 可能沒有可讀取的感測器（需 M2 以上或部分 M1 Pro）"})
				start = now.Add(time.Hour) // say it once
			}
			if gotData {
				f := map[string]any{"t": "f", "g": round3(grav), "d": round(peak, 5), "v": round3(peakVec)}
				if !math.IsNaN(lidAngle) {
					f["lid"] = round(lidAngle, 1)
				}
				if err := send(f); err != nil {
					return nil
				}
			}
			peak, peakVec = 0, [3]float64{}
		}
	}
}

func vecLen(v [3]float64) float64 { return math.Sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) }
func round(v float64, d int) float64 {
	p := math.Pow(10, float64(d))
	return math.Round(v*p) / p
}
func round3(v [3]float64) [3]float64 {
	return [3]float64{round(v[0], 4), round(v[1], 4), round(v[2], 4)}
}

// ───────────────────────────── server (user) ─────────────────────────────

type hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	status  map[string]any
}

func newHub() *hub {
	return &hub{clients: map[chan []byte]struct{}{}, status: map[string]any{"t": "status", "state": "idle"}}
}

func (h *hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c <- msg:
		default: // slow client: drop this frame
		}
	}
}

func (h *hub) setStatus(state, msg string) {
	st := map[string]any{"t": "status", "state": state}
	if msg != "" {
		st["msg"] = msg
	}
	b, _ := json.Marshal(st)
	h.mu.Lock()
	h.status = st
	h.mu.Unlock()
	h.broadcast(b)
	if msg != "" {
		fmt.Printf("[感測器] %s：%s\n", state, msg)
	} else {
		fmt.Printf("[感測器] %s\n", state)
	}
}

func (h *hub) currentStatus() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, _ := json.Marshal(h.status)
	return b
}

type sensorManager struct {
	h        *hub
	sockPath string
	self     string
	mu       sync.Mutex
	starting bool
	conn     net.Conn
}

func (m *sensorManager) state() string {
	var st map[string]any
	json.Unmarshal(m.h.currentStatus(), &st)
	s, _ := st["state"].(string)
	return s
}

// start launches the root helper, preferring a cached sudo ticket and
// falling back to the standard macOS administrator password dialog.
func (m *sensorManager) start() {
	m.mu.Lock()
	if m.starting || m.conn != nil {
		m.mu.Unlock()
		return
	}
	m.starting = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.starting = false; m.mu.Unlock() }()

	args := []string{"sensor", "--socket", m.sockPath, "--parent", fmt.Sprint(os.Getpid())}
	if exec.Command("sudo", "-n", "true").Run() == nil {
		m.h.setStatus("authorizing", "使用終端機的 sudo 授權")
		cmd := exec.Command("sudo", append([]string{"-n", m.self}, args...)...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return
		}
	}
	m.h.setStatus("authorizing", "請在 macOS 視窗輸入密碼，允許讀取加速度感測器")
	line := shellQuote(m.self)
	for _, a := range args {
		line += " " + shellQuote(a)
	}
	line += " >/dev/null 2>&1 &"
	script := fmt.Sprintf(`do shell script %s with prompt %s with administrator privileges`,
		appleQuote(line), appleQuote("TapVRM 需要讀取 MacBook 的加速度感測器，讓你的 VRM 分身感覺到敲擊。"))
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if strings.Contains(msg, "-128") {
			msg = "已取消授權。按頁面上的「連接感測器」可再試一次。"
		}
		m.h.setStatus("denied", msg)
		return
	}
	// Wait for the helper to dial back.
	for i := 0; i < 50; i++ {
		m.mu.Lock()
		ok := m.conn != nil
		m.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	m.h.setStatus("error", "感測器程式沒有回應")
}

func (m *sensorManager) accept(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		m.mu.Lock()
		if m.conn != nil {
			m.mu.Unlock()
			c.Close()
			continue
		}
		m.conn = c
		m.mu.Unlock()
		go m.read(c)
	}
}

func (m *sensorManager) read(c net.Conn) {
	m.h.setStatus("connecting", "")
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		var probe struct {
			T   string `json:"t"`
			Msg string `json:"msg"`
		}
		if json.Unmarshal(line, &probe) != nil {
			continue
		}
		switch probe.T {
		case "live":
			m.h.setStatus("live", "")
		case "error":
			m.h.setStatus("error", probe.Msg)
		case "f", "tap":
			m.h.broadcast(line)
		}
	}
	c.Close()
	m.mu.Lock()
	m.conn = nil
	m.mu.Unlock()
	if s := m.state(); s == "live" || s == "connecting" {
		m.h.setStatus("idle", "感測器已中斷")
	}
}

func (m *sensorManager) stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.conn != nil {
		m.conn.Close()
	}
}

func runServer(args []string) error {
	fl := flag.NewFlagSet("tapvrm", flag.ContinueOnError)
	port := fl.Int("port", 8131, "port on 127.0.0.1")
	noOpen := fl.Bool("no-open", false, "do not open the browser")
	noSensor := fl.Bool("no-sensor", false, "do not start the sensor automatically")
	replay := fl.String("replay", "", "cycle tap events from a JSON-lines file (spank format)")
	webDir := fl.String("web", "", "serve web files from this folder instead of the built-in copy")
	var clean []string
	for _, a := range args {
		if !strings.HasPrefix(a, "-psn_") { // added by old Finder launches
			clean = append(clean, a)
		}
	}
	if err := fl.Parse(clean); err != nil {
		return err
	}

	// Already running? Just bring the page up again.
	if *replay == "" {
		for p := *port; p < *port+20; p++ {
			u := fmt.Sprintf("http://127.0.0.1:%d/", p)
			c := http.Client{Timeout: 300 * time.Millisecond}
			if r, err := c.Get(u + "api/ping"); err == nil {
				b := make([]byte, 16)
				n, _ := r.Body.Read(b)
				r.Body.Close()
				if string(b[:n]) == "tapvrm" {
					fmt.Println("TapVRM 已經在執行：", u)
					if !*noOpen {
						exec.Command("open", u).Start()
					}
					return nil
				}
			}
		}
	}

	self, err := os.Executable()
	if err != nil {
		return err
	}
	self, _ = filepath.EvalSymlinks(self)

	tmp, err := os.MkdirTemp("", "tapvrm-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	sockPath := filepath.Join(tmp, "sensor.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return err
	}
	defer ln.Close()
	os.Chmod(sockPath, 0o600)

	h := newHub()
	mgr := &sensorManager{h: h, sockPath: sockPath, self: self}
	go mgr.accept(ln)

	var static fs.FS
	if *webDir != "" {
		static = os.DirFS(*webDir)
	} else {
		static, _ = fs.Sub(webFS, "web")
	}

	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServerFS(static)))
	mux.HandleFunc("/api/stream", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no streaming", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		ch := make(chan []byte, 64)
		h.mu.Lock()
		h.clients[ch] = struct{}{}
		h.mu.Unlock()
		defer func() { h.mu.Lock(); delete(h.clients, ch); h.mu.Unlock() }()
		fmt.Fprintf(w, "retry: 1000\ndata: %s\n\n", h.currentStatus())
		fl.Flush()
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case msg := <-ch:
				fmt.Fprintf(w, "data: %s\n\n", msg)
				fl.Flush()
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
				fl.Flush()
			}
		}
	})
	quit := make(chan struct{}, 1)
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "tapvrm") })
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-TapVRM") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		select {
		case quit <- struct{}{}:
		default:
		}
	})
	// Speak with the macOS voice (no browser autoplay rules). A new line interrupts the previous one;
	// the request returns when speech ends so the page can stop the mouth animation.
	var sayMu sync.Mutex
	var sayCmd *exec.Cmd
	voice := pickVoice()
	mux.HandleFunc("/api/say", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-TapVRM") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var req struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || strings.TrimSpace(req.Text) == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		args := []string{"-r", "215"}
		if voice != "" {
			args = append(args, "-v", voice)
		}
		cmd := exec.Command("say", append(args, "--", req.Text)...)
		sayMu.Lock()
		if sayCmd != nil && sayCmd.Process != nil {
			sayCmd.Process.Kill()
		}
		sayCmd = cmd
		err := cmd.Start()
		sayMu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cmd.Wait()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/sensor/start", func(w http.ResponseWriter, r *http.Request) {
		// Custom header ⇒ cross-site pages can't trigger this without a CORS preflight we never answer.
		if r.Method != http.MethodPost || r.Header.Get("X-TapVRM") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		go mgr.start()
		w.WriteHeader(http.StatusNoContent)
	})

	var listener net.Listener
	for p := *port; p < *port+20; p++ {
		if listener, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			break
		}
	}
	if listener == nil {
		return fmt.Errorf("找不到可用的連接埠：%w", err)
	}
	url := "http://" + listener.Addr().String() + "/"
	srv := &http.Server{Handler: mux}
	go srv.Serve(listener)
	fmt.Printf("TapVRM 已啟動：%s\n關閉這個視窗或按 Ctrl-C 結束。\n", url)

	if *replay != "" {
		go runReplay(*replay, h)
	}
	if !*noOpen {
		exec.Command("open", url).Start()
	}
	if !*noSensor && *replay == "" {
		go mgr.start()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	select {
	case <-sig:
	case <-quit:
	}
	fmt.Println("\n結束 TapVRM…")
	mgr.stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	return nil
}

func runReplay(path string, h *hub) {
	data, err := os.ReadFile(path)
	if err != nil {
		h.setStatus("error", "讀不到回放檔："+err.Error())
		return
	}
	var lines []map[string]any
	for _, l := range strings.Split(string(data), "\n") {
		var item struct {
			N   int     `json:"slapNumber"`
			Amp float64 `json:"amplitude"`
			Sev string  `json:"severity"`
		}
		if json.Unmarshal([]byte(l), &item) == nil && item.Amp >= 0 {
			lines = append(lines, map[string]any{"t": "tap", "amp": item.Amp, "sev": item.Sev, "src": "replay"})
		}
	}
	if len(lines) == 0 {
		h.setStatus("error", "回放檔沒有有效事件")
		return
	}
	h.setStatus("replay", path)
	for n := 1; ; n++ {
		for _, ev := range lines {
			time.Sleep(1500 * time.Millisecond)
			ev["n"] = n
			b, _ := json.Marshal(ev)
			h.broadcast(b)
		}
	}
}

// pickVoice prefers Meijia (zh-TW), then any zh_TW voice, then any Chinese voice.
func pickVoice() string {
	out, err := exec.Command("say", "-v", "?").Output()
	if err != nil {
		return ""
	}
	var tw, zh string
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		name := f[0]
		if i := strings.Index(line, " ("); i > 0 {
			name = strings.TrimSpace(line[:i])
		}
		switch {
		case strings.Contains(line, "zh_TW") && strings.HasPrefix(name, "Meijia"):
			return name
		case strings.Contains(line, "zh_TW") && tw == "":
			tw = name
		case strings.Contains(line, "zh_") && zh == "":
			zh = name
		}
	}
	if tw != "" {
		return tw
	}
	return zh
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
func appleQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
