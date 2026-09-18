# Kimlik doğrulama ve anahtar yönetimi

Halyard'da iki ayrı kimlik doğrulama yolu vardır: API anahtarları ve tarayıcı konsolu için OIDC. Bunlar
birbirinin yerine geçmez. Anahtarlar makineler içindir, OIDC insanlar içindir ve ikisi aynı yetki
tablosunu kullanır.

## API anahtarları

Bir anahtar `Authorization: Bearer <anahtar>` başlığıyla gönderilir. Bilinmeyen ya da eksik anahtar
`401`, geçerli olup yetkisi yetmeyen anahtar `403` alır. Bu ayrımın korunması bilinçlidir: her
başarısızlığın aynı göründüğü bir kurulumda hata ayıklanamaz.

```bash
halyardctl keys mint --name "siparis-servisi" --scope events:write
```

Anahtar yalnızca bu komutun çıktısında bir kez görünür. Veritabanında yalnızca özeti ve tanınabilmesi
için kısa bir öneki saklanır; kaybedilen anahtar kurtarılamaz, yenisi üretilir.

Kapsamlar şunlardır:

| Kapsam | Ne yapabilir |
|---|---|
| `events:write` | Olay yayımlar. Olay türü bazında bir sınırlama yoktur. |
| `deliveries:read` | Gönderimleri ve deneme geçmişlerini listeler ve okur. |
| `deliveries:replay` | Gönderimleri yeniden tetikler. `deliveries:read` yetkisini kapsamaz. |
| `endpoints:write` | Uç nokta oluşturur, günceller, devre dışı bırakır. |
| `admin` | Yukarıdakilerin tamamı, ayrıca anahtar üretme ve iptal etme. |

Anahtarın iptali bir sonraki istekte geçerlidir, yeniden başlatmada değil:

```bash
halyardctl keys revoke key_01J8ZF
```

## Ortam değişkenindeki durağan anahtarlar

`HALYARD_ADMIN_API_KEYS` değişkenine virgülle ayrılmış anahtarlar yazılabilir. Bu anahtarlar tam
yetkilidir, kapsamlandırılamaz, yeniden başlatmadan iptal edilemez ve ortam değişkenlerinizi kim
görüyorsa onun elindedir.

Bunlar ilk kurulum ve sürekli tümleştirme içindir. Kalıcı bir kullanım için bırakılmaları, iptal
edilebilirliğin tamamen kaybedilmesi anlamına gelir; bir sızıntı durumunda yapılabilecek tek şey
değişkeni değiştirip her kopyayı yeniden başlatmaktır.

## OIDC ile tarayıcı konsolu

`HALYARD_OIDC_ISSUER` ayarlandığı anda konsol etkinleşir. Ayarlanmadığında konsol hiç sunulmaz —
kimlik doğrulaması olmayan bir konsol diye bir şey yoktur.

```bash
HALYARD_OIDC_ISSUER=https://kimlik.ornek.test/realms/uretim
HALYARD_OIDC_CLIENT_ID=halyard
HALYARD_OIDC_CLIENT_SECRET=...
HALYARD_OIDC_REDIRECT_URL=https://halyard.ornek.test/oidc/callback
HALYARD_OIDC_ADMIN_GROUPS=platform-yoneticileri
```

`HALYARD_OIDC_REDIRECT_URL` değeri, sağlayıcıya kaydettiğiniz yönlendirme adresiyle sondaki eğik
çizgiye varıncaya kadar birebir aynı olmalıdır. Kurulumlarda en sık karşılaşılan aksaklık budur ve
sağlayıcının verdiği hata iletisi genellikle yeterince açıklayıcı değildir.

`HALYARD_OIDC_ADMIN_GROUPS` boş bırakıldığında, kimliği doğrulanmış her kullanıcı yalnızca okuma
yetkisine sahip olur. Yani yanlış yapılandırılmış bir kurulumda risk, fazla yetki değil, hiç yetki
verilmemesidir.

## Neden olay türü bazında yetki yok

Sık sorulan ve bilinçli olarak reddedilmiş bir istektir. `events:write` yetkisine sahip bir anahtar her
türü yayımlayabilir. Bir yayımcının başka bir ekibin uç noktasını tetikleyememesi gerekiyorsa, çözüm
ayrı bir Halyard kurulumudur; tek kurulum içinde tür bazında yetkilendirme, abonelikler değiştikçe
sessizce yanlışa dönüşen bir yetki tablosu üretir.
