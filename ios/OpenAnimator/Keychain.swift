import Foundation
import Security

/// Las claves de la app (el token de Claude Code, las de los plugins) en el Llavero de iOS: cifradas por el sistema,
/// sólo para esta app y fuera de los respaldos que se pueden leer. Se guardan juntas, como un JSON {nombre: valor}.
enum Keychain {
    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.openanimator.secrets",
        kSecAttrAccount as String: "secrets",
    ]

    static func load() -> String {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    static func save(_ json: String) -> Bool {
        let data = Data(json.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}
