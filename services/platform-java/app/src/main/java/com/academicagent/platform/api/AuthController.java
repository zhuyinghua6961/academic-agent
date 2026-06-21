package com.academicagent.platform.api;

import java.util.Map;

import com.academicagent.platform.identity.model.AuthResult;
import com.academicagent.platform.identity.service.AuthService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final CurrentUserProvider currentUserProvider;

    public AuthController(AuthService authService, CurrentUserProvider currentUserProvider) {
        this.authService = authService;
        this.currentUserProvider = currentUserProvider;
    }

    @PostMapping("/register")
    public ResponseEntity<Map<String, Object>> register(@Valid @RequestBody RegisterRequest request) {
        AuthResult result = authService.register(request.email(), request.password(), request.displayName());
        return ResponseEntity.status(HttpStatus.CREATED).body(authBody(result));
    }

    @PostMapping("/login")
    public Map<String, Object> login(@Valid @RequestBody LoginRequest request) {
        return authBody(authService.login(request.email(), request.password()));
    }

    @GetMapping("/me")
    public Map<String, Object> me() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return ApiMappers.userProfile(authService.getProfile(user.getUserId()));
    }

    private Map<String, Object> authBody(AuthResult result) {
        return Map.of(
                "access_token", result.accessToken(),
                "token_type", result.tokenType(),
                "expires_in", result.expiresIn(),
                "user", ApiMappers.userProfile(result.user()));
    }

    public record RegisterRequest(
            @NotBlank @Email String email,
            @NotBlank @Size(min = 8) String password,
            @NotBlank String displayName) {}

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {}
}
