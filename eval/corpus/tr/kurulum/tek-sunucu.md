# Tek sunucuya kurulum

Bu sayfa, elinizde bir kapsayıcı çalıştırıcısı olmadığında Halyard'ı tek bir Linux sunucusuna nasıl
kuracağınızı anlatır. Kurulumun tamamı bir ikili dosya, bir systemd birimi ve bir PostgreSQL veritabanıdır;
bunların dışında kalıcı olarak çalışan başka hiçbir bileşen yoktur.

## Docker olmadan

Docker'sız kurulum, Halyard'ın tasarımında sonradan eklenmiş bir seçenek değil, asıl yoldur. Sunucu tek
bir statik ikili dosyadır ve dışarıdan hiçbir paylaşılan kütüphaneye bağlı değildir; dolayısıyla
dağıtımınızın sürümüyle uyuşmazlık yaşama ihtimaliniz yoktur.

```bash
curl -fsSL https://dl.halyard.dev/2.7.0/halyardctl-linux-amd64 -o /usr/local/bin/halyardctl
chmod 0755 /usr/local/bin/halyardctl
halyardctl version
```

Sürüm çıktısındaki şema numarasını not edin. Yükseltmelerden sonra veritabanının hangi şemada
kaldığını anlamanın en hızlı yolu budur.

Ardından ayrıcalıksız bir sistem kullanıcısı ve durum dizini oluşturun:

```bash
useradd --system --home /var/lib/halyard --shell /usr/sbin/nologin halyard
install -d -o halyard -g halyard -m 0750 /var/lib/halyard
install -d -o root -g halyard -m 0750 /etc/halyard
```

`/var/lib/halyard` dizini yük dosyalarının yazıldığı yerdir ve yeniden başlatmalar arasında
korunmalıdır. Bu dizini geçici bir dosya sisteminde bırakırsanız, büyük gövdeli olayların yeniden
gönderilebilirliğini kaybedersiniz.

## Ortam dosyası

```bash
cat > /etc/halyard/halyard.env <<'ENV'
HALYARD_DATABASE_URL=postgres://halyard:degistirin@127.0.0.1:5432/halyard?sslmode=disable
HALYARD_SIGNING_SECRET=buraya-en-az-32-baytlik-rastgele-bir-deger
HALYARD_LISTEN_ADDR=127.0.0.1:8480
HALYARD_METRICS_ADDR=127.0.0.1:9480
HALYARD_DATA_DIR=/var/lib/halyard
ENV
chown root:halyard /etc/halyard/halyard.env
chmod 0640 /etc/halyard/halyard.env
```

`HALYARD_LISTEN_ADDR` değerini kasıtlı olarak geri döngü adresine bağlıyoruz. TLS sonlandırmasını aynı
makinedeki ters vekil sunucu yapacaksa, uygulamanın dışarıya doğrudan açılması gereksizdir ve
açılmaması güvenlik açısından ölçülebilir bir kazançtır.

## systemd birimi

```ini
[Unit]
Description=Halyard
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=notify
User=halyard
Group=halyard
EnvironmentFile=/etc/halyard/halyard.env
ExecStartPre=/usr/local/bin/halyardctl migrate
ExecStart=/usr/local/bin/halyardctl serve
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60s
KillSignal=SIGTERM
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/halyard

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` değeri `HALYARD_DRAIN_TIMEOUT` değerinden büyük olmalıdır. Aksi hâlde systemd, sunucu
elindeki gönderimleri tamamlamayı bitiremeden süreci `SIGKILL` ile sonlandırır; bu gönderimler
kaybolmaz ama kiralama süreleri dolana kadar başka hiçbir kopya tarafından üstlenilemez.

`Type=notify` kullanıldığında sunucu, veritabanına bağlanıp göç işlemlerini doğruladıktan sonra hazır
olduğunu systemd'ye bildirir. Bu sayede `systemctl start` komutu, süreç gerçekten hizmet verebilir
duruma gelmeden geri dönmez.

## Ters vekil sunucu

```nginx
location / {
    proxy_pass http://127.0.0.1:8480;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 70s;
}
```

Vekil sunucu kullanıyorsanız `HALYARD_TRUSTED_PROXIES` değişkenine vekilin adres bloğunu yazmadan
`X-Forwarded-For` başlığı dikkate alınmaz. Bu, varsayılan olarak güvenilmemesinin bilinçli sonucudur:
güvenilmeyen bir başlığa dayanarak hız sınırlaması uygulamak, hız sınırlaması uygulamamaktan daha
kötüdür.

## Kurulumun doğrulanması

```bash
systemctl enable --now halyard
halyardctl doctor
curl -fsS http://127.0.0.1:8480/readyz
```

`halyardctl doctor` komutu veritabanı bağlantısını, şema sürümünü, veri dizininin yazılabilirliğini,
imzalama yapılandırmasını ve saat kaymasını sırayla denetler. Herhangi biri başarısız olursa komut `1`
ile çıkar ve hangi denetimin neden başarısız olduğunu tek satırda söyler.
